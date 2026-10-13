# SISC Manager — Backend (`back-end-sisc`)

Monorepo Node.js com seis microserviços de observabilidade e gestão operacional para o Portal SISC Manager (DETRAN-DF / Very Tecnologia).

---

## Visão Geral

```
back-end-sisc/
├── svc-platform-control/   # Hub central: autenticação, tenants, OAuth Dynatrace
├── svc-inventory/          # Inventário assíncrono de entidades Dynatrace
├── svc-apm/                # Métricas APM ao vivo + relatórios .docx
├── svc-apdex/              # Cálculo de Apdex score via USQL/RUM
├── svc-schedule/           # Gestão de escala operacional (12x36)
└── svc-license/            # Gestão de licenciamento Dynatrace (DPS e Classic)
```

**Stack comum:** Node.js 20 · Express · MongoDB Atlas · JWT  
**Infra:** Kubernetes/OpenShift (AGU) · GitLab CI/CD · ArgoCD · Harbor Registry

---

## CI/CD e Deploy

### Pipeline GitLab (`.gitlab-ci.yml`)

O pipeline constrói as 5 imagens em paralelo via `parallel:matrix` e atualiza os `kustomization.yaml` de cada ambiente no repositório `gitops-config`.

Variáveis de grupo obrigatórias: `HARBOR_REGISTRY`, `HARBOR_ROBOT_USERNAME`, `HARBOR_ROBOT_SECRET`, `GITOPS_REPO`, `GITOPS_REPO_SSH_KEY`, `GITLAB_HOST`.

### Fluxo de promoção

| Trigger | Ambiente | Imagem tag |
|---|---|---|
| Push em `main` | QA | `sha-<short_sha>` |
| `git tag vX.Y.Z` | Staging | `vX.Y.Z` |
| Job manual no ArgoCD | Produção | `vX.Y.Z` |

```bash
# QA — automático ao fazer merge em main
git push origin main

# Staging + Produção
git tag -a v1.2.3 -m "release v1.2.3"
git push origin v1.2.3
# → staging sobe automaticamente
# → produção: play manual no job deploy-prod + sync no ArgoCD
```

### Roteamento Envoy

O roteamento externo (`/svc/<nome>/api/...`) é gerenciado pelo **Envoy Gateway** via `httproute-svc-*.yaml` no `gitops-config` (acesso restrito à equipe SRE). O Envoy faz strip do prefixo antes de repassar ao pod, portanto cada serviço registra suas rotas sem o prefixo `/svc/<nome>`.

> **Nota:** Para garantir compatibilidade em caso de Envoy sem strip, o `svc-inventory` registra as rotas **com e sem** o prefixo.

### Ambientes

| Ambiente | URL |
|---|---|
| Produção | `sisc-manager.verytecnologia.com.br` |
| Staging | `sisc-manager-staging.verytecnologia.com.br` |
| QA | `sisc-manager-qa.verytecnologia.com.br` |

---

## Autenticação

Três mecanismos coexistem no sistema:

| Mecanismo | Header | Uso |
|---|---|---|
| JWT | `Authorization: Bearer <token>` | Usuários via frontend (emitido pelo `svc-platform-control`) |
| Service Key | `x-service-key: <key>` | Comunicação interna serviço-a-serviço |
| Cron Secret | `x-cron-secret: <secret>` | Scheduler externo → `svc-inventory` |

---

## Variáveis de Ambiente Comuns

| Variável | Descrição |
|---|---|
| `MONGODB_URI` | Connection string MongoDB Atlas |
| `JWT_SECRET` | Secret para assinar/verificar tokens JWT |
| `SERVICE_API_KEY` | Chave para comunicação interna entre serviços |
| `PLATFORM_CONTROL_URL` | URL interna do `svc-platform-control` (ex: `http://svc-platform-control:3002`) |
| `PORT` | Porta de escuta do serviço |

---

## Serviços

### `svc-platform-control` — porta `3002`

Hub central do sistema. Gerencia tenants Dynatrace, usuários, credenciais OAuth e emite JWTs.

**Variáveis específicas:**
```env
PORT=3002
MONGODB_URI=mongodb+srv://...
JWT_SECRET=...
SERVICE_API_KEY=...
TENANTS_CACHE_INTERVAL_MS=300000   # revalidação do cache in-memory (padrão: 5 min)
```

**Cache de tenants:** na inicialização, todos os tenants são carregados do Atlas em um `Map` em memória (revalidado a cada `TENANTS_CACHE_INTERVAL_MS`). As rotas recebem o tenant via `x-tenant-id` (header) ou `?tenantId=` (query).

**Endpoints:**
```
GET    /health
POST   /api/auth/login                                        # autenticação de usuário → JWT
GET    /api/config                                            # configuração geral (protegido)
GET    /api/dynaTenant                                        # lista tenants
POST   /api/dynaTenant                                        # cadastra tenant
GET    /api/dynaTenant/:id                                    # busca tenant por ID
PATCH  /api/dynaTenant/:id/baseUrl                           # atualiza URL base
GET    /api/dynatrace/platform-credentials                    # lista credenciais OAuth
POST   /api/dynatrace/platform-credentials                    # cria credencial OAuth
GET    /api/dynatrace/platform-credentials/resolve-bearer/:tenantId   # obtém Bearer token (uso interno)
GET    /api/dynatrace/tokens                                  # lista API tokens
```

**Estrutura de arquivos relevantes:**
```
svc-platform-control/
├── server.js
├── config/database.js
├── models/
│   ├── DynatraceTenants.js
│   └── DynatracePlatformCredentials.js
├── routes/
│   ├── healthRoutes.js
│   ├── authRoutes.js
│   ├── config.js
│   ├── dynaTenantsRoutes.js
│   ├── dynaPlatformCredentialsRoutes.js
│   └── dynaTokenRoutes.js
├── middleware/authMiddleware.js
└── constants/
    └── dynatraceScopes.js       # scopes OAuth centralizados
```

**Scopes OAuth (`dynatraceScopes.js`):** centraliza as constantes usadas pelos relatórios e pelo inventário. Após alterar scopes, invalide o cache de bearer no Atlas:
```js
// MongoDB — coleção dynatraceplatformcredentials
db.dynatraceplatformcredentials.updateMany({}, { $set: { _bearerToken: null, _bearerExpiresAt: null } })
```

---

### `svc-inventory` — porta `3003`

Inventário assíncrono completo de entidades Dynatrace com cache em memória e exportação `.docx`.

**Variáveis específicas:**
```env
PORT=3003
MONGODB_URI=mongodb+srv://...
PLATFORM_CONTROL_URL=http://svc-platform-control:3002
SERVICE_API_KEY=...
```

**Endpoints:**
```
GET    /health
POST   /api/dynatrace/inventory/:tenantId/validate           # testa conectividade e corrige baseUrl
POST   /api/dynatrace/inventory/:tenantId/run                # executa inventário completo
POST   /api/dynatrace/inventory/:tenantId/run?force=true     # força re-execução ignorando cache
GET    /api/dynatrace/inventory/:tenantId                    # retorna último resultado em cache
DELETE /api/dynatrace/inventory/:tenantId/cache              # invalida cache (TTL: 30 min)
GET    /api/dynatrace/inventory/:tenantId/export             # exporta .docx completo
GET    /api/dynatrace/inventory/:tenantId/export/dashboards
GET    /api/dynatrace/inventory/:tenantId/export/applications
GET    /api/dynatrace/inventory/:tenantId/export/infrastructure
```

**Entidades coletadas (42 categorias):**

*Entidades (Entities API v2):*
`HOST` · `PROCESS_GROUP` · `SERVICE` · `APPLICATION` · `KUBERNETES_CLUSTER` · `KUBERNETES_NODE` · `CLOUD_APPLICATION` · `CLOUD_APPLICATION_NAMESPACE` · `DISK` · `NETWORK_INTERFACE` · `SYNTHETIC_TEST` · `CUSTOM_DEVICE`

*Configurações (Config API v1 + v2):*
`DATABASE_SERVICE` · `DASHBOARDS_CLASSIC` · `DASHBOARDS_GEN3` · `NOTEBOOKS` · `AUTOMATION_WORKFLOWS` · `AUTOMATION_RULES` · `AUTOMATION_CALENDARS` · `ALERTING_PROFILES` · `AUTO_TAG_RULES` · `MANAGEMENT_ZONES` · `MAINTENANCE_WINDOWS` · `NOTIFICATIONS` · `REQUEST_ATTRIBUTES` · `CALCULATED_METRICS` · `ANOMALY_METRIC_EVENTS` · `CONDITIONAL_NAMING` · `WEB_APPLICATIONS` · `MOBILE_APPLICATIONS` · `SYNTHETIC_MONITORS` · `SYNTHETIC_LOCATIONS` · `ACTIVE_GATES` · `ACTIVE_GATE_TOKENS` · `NETWORK_ZONES` · `ONE_AGENTS` · `SLO` · `SECURITY_PROBLEMS` · `RELEASES` · `ATTACKS` · `EXTENSIONS` · `METRIC_DESCRIPTORS` · `API_TOKENS` · `CREDENTIALS`

**Comportamentos importantes:**
- Inclui entidades **inativas** com janela de 35 dias (`state(ACTIVE,INACTIVE)` + `from=now-35d`) para cobrir tenants com execuções periódicas/mensais (ex: ENEM).
- Filtros de ruído K8s removem automaticamente namespaces/workloads do sistema OpenShift (`openshift-*`, `kube-*`, `cluster-*`).
- Entidades opcionais (`ATTACKS`, `SECURITY_PROBLEMS`, `ONE_AGENTS`) retornam `[]` silenciosamente em 403/404.
- `validateTenant` detecta e corrige automaticamente `baseUrl` erradas via redirect 404 do Dynatrace.
- Resolução de URL via `utils/dynaFetch.js` — fallback automático `.live.` → `.apps.` com cache de 5 min.

**Estrutura de arquivos relevantes:**
```
svc-inventory/
├── server.js
├── controllers/
│   ├── dynaInventoryController.js    # cache in-memory 30 min
│   ├── dynaInventoryService.js       # lógica principal (42 categorias)
│   ├── dynaInventoryExport.js        # .docx completo (OOXML/AdmZip)
│   └── dynaInventoryExportSpecific.js # exports parciais
├── services/
│   └── platformControlClient.js      # HTTP client para svc-platform-control
├── routes/
│   └── dynaInventoryRoutes.js
└── utils/
    └── dynaFetch.js                   # resolução .live.↔.apps. com cache
```

**Dependências nativas (requer build):**
```bash
npm install adm-zip
```

---

### `svc-apm` — porta `3004`

Métricas APM em tempo real (dashboard) e geração de relatórios mensais `.docx` para DETRAN-DF.

**Variáveis específicas:**
```env
PORT=3004
MONGODB_URI=mongodb+srv://...
PLATFORM_CONTROL_URL=http://svc-platform-control:3002
SERVICE_API_KEY=...
```

**Endpoints de métricas (dashboard):**
```
GET    /health
GET    /api/infra/host-availability
GET    /api/services/action-groups
GET    /api/services/action-overview
GET    /api/services/browser-performance
GET    /api/user/apdex
GET    /api/user/apdex-categories
GET    /api/user/sessions
GET    /api/user/rage-clicks
GET    /api/user/bounce-rate
```

**Endpoint de relatório:**
```
GET    /api/report/:reportKey?id=<tenantId>&from=YYYY-MM-DD&to=YYYY-MM-DD
```

**`reportKey` disponíveis:**

| Chave | Aplicação | Tipo de infra |
|---|---|---|
| `portal` | Portal DETRAN-DF | K8s containers |
| `app` | AppDetran-DF (mobile) | K8s containers |
| `getran` | GETRAN | Hosts físicos (2 seções: externo + interno) |

**Seções do relatório `.docx`:**
1. **Introdução** — período, cliente, sistema
2. **Alertas** — DQL `fetch dt.davis.problems` via `.apps.dynatrace.com` + OAuth Bearer (fallback: Problems API v2)
3. **Performance** — tráfego (req/s), latência p90, erros 4xx/5xx — gráficos multi-linha por serviço, resolução 6h
4. **Banco de Dados** *(comentado — reservado para relatório dedicado futuro)*
5. **Infraestrutura** — CPU avg/max, memória avg — por container K8s ou host
6. **Experiência do Usuário** — Apdex, sessões ativas, rage clicks, bounce rate, geolocalização, sazonalidade

**Observações técnicas:**
- Gráficos via `chartjs-node-canvas` (canvas nativo C++) em resolução 1400×640, 20 séries, paleta `COLORS_20`.
- DQL/Grail via `.apps.dynatrace.com` + OAuth Bearer; Metrics API v2 via `.live.dynatrace.com` + Api-Token.
- `metricSelector` usa `:names` para resolver nomes legíveis de entidades.
- Imagens inseridas no Word com 17 cm de largura (6.120.000 EMU).

**Dependências (requerem build nativo):**
```bash
npm install adm-zip chartjs-node-canvas chart.js canvas
```

**Dockerfile (Alpine) — libs obrigatórias para o `canvas`:**
```dockerfile
RUN apk add --no-cache python3 make g++ cairo-dev pango-dev jpeg-dev \
    giflib-dev librsvg-dev pixman-dev
```

> ⚠️ Sem essas libs no Alpine, o serviço falha na inicialização com `Cannot find module '../build/Release/canvas.node'`.

**Estrutura de arquivos relevantes:**
```
svc-apm/
├── server.js
├── controllers/
│   ├── dynaInfraController.js
│   ├── dynaServicesController.js
│   ├── dynaUserSessionsController.js
│   └── reportController.js
├── services/
│   └── report/
│       ├── reportConfig.js          # queries DQL e metricSelectors por relatório
│       ├── reportDataService.js     # coleta dados via Dynatrace API
│       ├── reportOrchestrator.js    # coordena coleta + geração
│       └── docxBuilder.js           # monta .docx com gráficos (AdmZip + chartjs-node-canvas)
├── routes/
│   └── reportRoutes.js
└── utils/
    └── dynaHelpers.js
```

---

### `svc-apdex` — porta `3005`

Cálculo de Apdex score e análise de top páginas via USQL/RUM.

**Variáveis específicas:**
```env
PORT=3005
PLATFORM_CONTROL_URL=http://svc-platform-control:3002
SERVICE_API_KEY=...
```

**Endpoints:**
```
GET    /health
POST   /api/apdex-analyze
```

---

### `svc-schedule` — porta `3006`

Motor de geração de escalas operacionais 12×36 com exportação Excel e controle de ausências.

**Variáveis específicas:**
```env
PORT=3006
MONGODB_URI=mongodb+srv://...
SERVICE_API_KEY=...
```

**Endpoints:**
```
GET    /health
GET    /api/collaborator              # lista colaboradores
POST   /api/collaborator              # cadastra colaborador
PUT    /api/collaborator/:id
DELETE /api/collaborator/:id
GET    /api/absence                   # ausências (férias, atestado, folga)
POST   /api/absence
PUT    /api/absence/:id
DELETE /api/absence/:id
GET    /api/program                   # programas (Commercial, Evening, Fullnight)
GET    /api/dailySchedule             # escala do mês
POST   /api/dailySchedule/generate   # gera/regenera escala mensal
GET    /api/export/escala             # exporta escala mensal (.xlsx)
GET    /api/export/horas-extras       # exporta relatório de horas extras RH (.xlsx)
```

**Programas de trabalho:**

| Programa | Horário | Regime |
|---|---|---|
| `Commercial` | Horário comercial | 5×2 fixo |
| `Evening` | 19h–00h | Turno de 5h |
| `Fullnight` | 19h–07h | 12×36 noturno |

**Subgrupos de colaboradores:** `DIURNO` · `NOTURNO` · `FIXO`

**Estrutura de arquivos relevantes:**
```
svc-schedule/
├── server.js
├── config/
│   ├── database.js
│   └── config.js
├── models/
│   ├── Collaborator.js
│   ├── Absence.js
│   └── DailySchedule.js
├── controllers/
│   ├── collaboratorController.js
│   ├── AbsenceController.js
│   └── DailyScheduleController.js
├── routes/
│   ├── collaboratorRoutes.js
│   ├── absenceRoutes.js
│   └── dailyScheduleRouter.js
└── utils/
    ├── helpers.js
    ├── schedule.js      # motor de geração 12x36
    ├── daily.js
    ├── monthly.js
    ├── programs.js
    └── collaborators.js
```

> ⚠️ O `exceljs` é instalado via `npm install` em runtime — risco em redes com restrição de egress (clusters K8s sem acesso a `registry.npmjs.org`).

---

### `svc-license` — porta `3007`

Gestão e auditoria de licenciamento Dynatrace (modelos DPS e Classic).

**Variáveis específicas:**
```env
PORT=3007
MONGODB_URI=mongodb+srv://...
SERVICE_API_KEY=...
```

---

## Utilitário Compartilhado — `dynaFetch.js`

Presente em `utils/dynaFetch.js` em cada serviço que acessa o Dynatrace. Resolve automaticamente entre `.live.dynatrace.com` e `.apps.dynatrace.com` conforme a rede do host.

```js
const { dynaFetch, resolveBaseUrl, invalidateCache } = require('./utils/dynaFetch');

// Uso direto:
const res = await dynaFetch(tenant.baseUrl, '/api/v2/entities?...', { headers }, tenant.apiToken);

// Só para resolver a URL base:
const workingUrl = await resolveBaseUrl(tenant.baseUrl, tenant.apiToken);
```

**Funcionamento:**
1. Probe via `GET /api/v2/time` (sem auth, retorna 200 se acessível)
2. Se `AbortError`/timeout/`ENOTFOUND` → tenta `.apps.dynatrace.com`
3. Cache em memória por 5 minutos por baseUrl

---

## Padrões de Acesso Dynatrace

| API | Endpoint base | Autenticação |
|---|---|---|
| Entities v2, Metrics v2, Problems v2, Config v1 | `<tenant>.live.dynatrace.com` | `Api-Token` |
| DQL / Grail (alertas, queries) | `<tenant>.apps.dynatrace.com/platform/storage/query/v1` | Bearer (OAuth) |
| Documents API (Dashboards Gen3, Notebooks) | `<tenant>.apps.dynatrace.com/platform/document/v1` | Bearer (OAuth) |
| Automation API (Workflows, Rules, Calendars) | `<tenant>.apps.dynatrace.com/platform/automation/v1` | Bearer (OAuth) |

---

## Problemas Conhecidos e Pendências

| Issue | Serviço | Status |
|---|---|---|
| Auth middleware ausente em algumas rotas | `svc-apm`, `svc-apdex` | Pendente |
| Lógica de Apdex duplicada | `svc-apm` / `svc-apdex` | Pendente refatoração |
| `exceljs` instalado via `npm` em runtime | `svc-schedule` | Risco em redes com egress restrito |
| Scripts de teste commitados em `controllers/` | `svc-apm` | Pendente limpeza |
| Dois padrões de `.docx` coexistindo | `svc-apm` (lib `docx`) vs `svc-inventory` (AdmZip/OOXML) | Aceitável por ora |
| Cluster K8s QA/prod sem egress para `*.dynatrace.com:443` | Infra | Requer intervenção SRE |
| Relatório de Banco de Dados | `svc-apm` | Seção comentada; funções prontas em `reportDataService.js` |