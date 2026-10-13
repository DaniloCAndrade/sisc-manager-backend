/**
 * reportConfig.js
 * Configuração centralizada dos 3 relatórios.
 * Cada seção define as queries DQL e metricSelectors usados pelo reportDataService.
 */

const REPORT_CONFIGS = {

    // ── Portal DETRAN-DF ──────────────────────────────────────────────────────
    portal: {
        label: 'Portal DETRAN-DF',
        appType: 'web',
        infraType: 'container',
        sections: [{
            key: 'portal',
            label: 'Portal',
            infraType: 'container',

            // ── DQL (requer OAuth Bearer) ────────────────────────────────────────
            alertsDql: [
                'fetch dt.davis.problems',
                '| filter matchesValue(k8s.namespace.name, { "portal-prod" }) OR matchesValue(entityAttr(dt.entity.application, "entity.name"), "portal.detran.df.gov.br")',
                '| filter resolved_problem_duration > duration(15, "min")',
            ].join('\n'),

            // Erros via Metrics API builtin — mais preciso que DQL para este caso
            err4xxMetric: 'builtin:service.errors.fourxx.count:filter(in("dt.entity.service",entitySelector("type(service),tag(~"portal:~")"))):splitBy("dt.entity.service"):sort(value(auto,descending)):names',
            err5xxMetric: 'builtin:service.errors.fivexx.count:filter(in("dt.entity.service",entitySelector("type(service),tag(~"portal:~")"))):splitBy("dt.entity.service"):sort(value(auto,descending)):names',

            // ── EntitySelectors para Metrics API v2 ──────────────────────────────
            serviceEntitySelector: 'type(SERVICE),tag("portal")',
            infraEntitySelector: null,
            appEntitySelector: 'type(APPLICATION),entityName.equals("portal.detran.df.gov.br")',
            geoEntitySelector: null,
            problemEntitySelector: 'type(APPLICATION),entityName.equals("portal.detran.df.gov.br")',

            // ── Infra — containers K8s ────────────────────────────────────────────
            // Namespace usado no DQL de CPU/Memória por container_group
            // (dt.process.cpu.usage / dt.process.memory.usage) — ver reportDataService.js.
            k8sNamespace: 'portal-prod',
            // Mantidos como fallback (Metrics API v2) caso não haja OAuth Bearer
            // disponível — nesse tenant retornam 404 "No metric found", então
            // na prática o caminho ativo é sempre o DQL acima.
            cpuMetric: 'builtin:kubernetes.container.cpuUsage:splitBy("dt.entity.cloud_application_instance"):avg',
            cpuMaxMetric: 'builtin:kubernetes.container.cpuUsage:splitBy("dt.entity.cloud_application_instance"):max',
            memMetric: 'builtin:kubernetes.container.memoryWorkingSet:splitBy("dt.entity.cloud_application_instance"):avg',

            // ── UX — web app ─────────────────────────────────────────────────────
            // Banco de dados (MDA) — RESERVADO para o futuro relatório de BD
            // (não é usado no fluxo principal — ver reportDataService.js).
            dbMetric: 'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(20):names',
            dbTimeMetric: 'builtin:service.dbChildCallTime:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
            dbFailureMetric: 'builtin:service.dbconnections.failure:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
            dbFailureRateMetric: 'builtin:service.dbconnections.failureRate:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',

            apdexMetric: 'builtin:apps.web.apdex.userType:filter(eq("User type","Real users")):splitBy():avg',
            sessionsMetric: 'builtin:apps.web.activeSessions:splitBy():sum',
            rageMetric: 'builtin:apps.web.event.count.rageClick:splitBy():sum',
            bounceMetric: 'builtin:apps.web.bouncedSessionRatio:splitBy():avg',
            startedSessionsMetric: 'builtin:apps.web.startedSessions:splitBy():sum',
            activeSessionsMetric: 'builtin:apps.web.activeSessions:splitBy():sum',
            geoMetric: 'builtin:apps.web.actionCount.summary:splitBy("dt.entity.geolocation"):sum',

            hasCrashes: false,
        }],
    },

    // ── APP Detran-DF ─────────────────────────────────────────────────────────
    app: {
        label: 'AppDetran-DF',
        appType: 'mobile',
        infraType: 'container',
        sections: [{
            key: 'app',
            label: 'AppDetran-DF',
            infraType: 'container',

            alertsDql: [
                'fetch dt.davis.problems',
                '| filter matchesValue(k8s.namespace.name, { "microsservicos-app-prod" })',
                '  OR matchesValue(entityAttr(dt.entity.mobile_application, "entity.name"), "AppDetran-DF")',
                '| filter resolved_problem_duration > duration(15, "min")',
            ].join('\n'),

            err4xxMetric: 'builtin:service.errors.fourxx.count:filter(in("dt.entity.service",entitySelector("type(service),tag(~"app:~")"))):splitBy("dt.entity.service"):sort(value(auto,descending)):names',
            err5xxMetric: 'builtin:service.errors.fivexx.count:filter(in("dt.entity.service",entitySelector("type(service),tag(~"app:~")"))):splitBy("dt.entity.service"):sort(value(auto,descending)):names',

            serviceEntitySelector: 'type(SERVICE),tag("app")',
            infraEntitySelector: null,
            appEntitySelector: 'type(MOBILE_APPLICATION),entityName.equals("AppDetran-DF")',
            geoEntitySelector: null,
            problemEntitySelector: 'type(MOBILE_APPLICATION),entityName.equals("AppDetran-DF")',

            // ── Infra — containers K8s ────────────────────────────────────────────
            k8sNamespace: 'microsservicos-app-prod',
            cpuMetric: 'builtin:kubernetes.container.cpuUsage:splitBy("dt.entity.cloud_application_instance"):avg',
            cpuMaxMetric: 'builtin:kubernetes.container.cpuUsage:splitBy("dt.entity.cloud_application_instance"):max',
            memMetric: 'builtin:kubernetes.container.memoryWorkingSet:splitBy("dt.entity.cloud_application_instance"):avg',

            // Banco de dados (MDA) — RESERVADO para o futuro relatório de BD
            dbMetric: 'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(20):names',
            dbTimeMetric: 'builtin:service.dbChildCallTime:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
            dbFailureMetric: 'builtin:service.dbconnections.failure:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
            dbFailureRateMetric: 'builtin:service.dbconnections.failureRate:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',

            apdexMetric: 'builtin:apps.other.apdex.osAndVersion:splitBy():avg',
            sessionsMetric: 'builtin:apps.mobile.sessionCount.sessionReplayStatus:splitBy():sum',
            crashMetric: 'builtin:apps.other.crashCount.osAndVersion-std:splitBy():sum',
            geoMetric: 'builtin:apps.other.sessionCount.osAndGeo:splitBy("dt.entity.geolocation"):sum',

            rageMetric: null,
            bounceMetric: null,
            startedSessionsMetric: null,
            activeSessionsMetric: null,
            hasCrashes: true,
        }],
    },

    // ── GETRAN (externo + interno) ────────────────────────────────────────────
    getran: {
        label: 'GETRAN',
        appType: 'web',
        infraType: 'host',
        sections: [
            {
                key: 'externo',
                label: 'Getran (Produção)',
                infraType: 'host',

                alertsDql: [
                    'fetch dt.davis.problems',
                    '| filter matchesValue(entityAttr(dt.entity.application, "entity.name"), "getran.detran.df.gov.br")',
                    '  OR matchesValue(host.name, { "epica.detran.df", "evanda.detran.df", "eagle.detran.df", "esteem.detran.df", "equus.detran.df" })',
                    '| filter resolved_problem_duration > duration(15, "min")',
                ].join('\n'),

                err4xxMetric: 'builtin:service.errors.fourxx.count:splitBy("dt.entity.service"):sort(value(auto,descending)):names',

                err5xxMetric: 'builtin:service.errors.fivexx.count:splitBy("dt.entity.service"):sort(value(auto,descending)):names',

                serviceEntitySelector: 'type(SERVICE),entityName.contains("getran.detran")',
                infraEntitySelector: 'type(HOST),tag("GETRAN:PRODUÇÃO")',
                appEntitySelector: 'type(APPLICATION),entityName.equals("getran.detran.df.gov.br")',
                geoEntitySelector: null,
                problemEntitySelector: 'type(APPLICATION),entityName.equals("getran.detran.df.gov.br")',

                cpuMetric: 'builtin:host.cpu.usage:splitBy("dt.entity.host"):avg',
                cpuMaxMetric: 'builtin:host.cpu.usage:splitBy("dt.entity.host"):max',
                memMetric: 'builtin:host.mem.usage:splitBy("dt.entity.host"):avg',

                // Banco de dados (MDA) — RESERVADO para o futuro relatório de BD
                dbMetric: 'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(20):names',
                dbTimeMetric: 'builtin:service.dbChildCallTime:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
                dbFailureMetric: 'builtin:service.dbconnections.failure:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
                dbFailureRateMetric: 'builtin:service.dbconnections.failureRate:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',

                apdexMetric: 'builtin:apps.web.apdex.userType:filter(eq("User type","Real users")):splitBy():avg',
                sessionsMetric: 'builtin:apps.web.activeSessions:splitBy():sum',
                rageMetric: 'builtin:apps.web.event.count.rageClick:splitBy():sum',
                bounceMetric: 'builtin:apps.web.bouncedSessionRatio:splitBy():avg',
                startedSessionsMetric: 'builtin:apps.web.startedSessions:splitBy():sum',
                activeSessionsMetric: 'builtin:apps.web.activeSessions:splitBy():sum',
                geoMetric: 'builtin:apps.web.actionCount.summary:splitBy("dt.entity.geolocation"):sum',

                hasCrashes: false,
            },
            {
                key: 'interno',
                label: 'Getran-Interno',
                infraType: 'host',

                alertsDql: [
                    'fetch dt.davis.problems',
                    '| filter matchesValue(entityAttr(dt.entity.application, "entity.name"), "getran-interno.detran.df.gov.br")',
                    '  OR matchesValue(host.name, { "elite.detran.df", "elise.detran.df" })',
                    '| filter resolved_problem_duration > duration(15, "min")',
                ].join('\n'),

                err4xxMetric: 'builtin:service.errors.fourxx.count:splitBy("dt.entity.service"):sort(value(auto,descending)):names',

                err5xxMetric: 'builtin:service.errors.fivexx.count:splitBy("dt.entity.service"):sort(value(auto,descending)):names',

                serviceEntitySelector: 'type(SERVICE),tag("getran:interno")',
                infraEntitySelector: 'type(HOST),tag("GETRAN:INTERNO")',
                appEntitySelector: 'type(APPLICATION),entityName.equals("getran-interno.detran.df.gov.br")',
                geoEntitySelector: null,
                problemEntitySelector: 'type(APPLICATION),entityName.equals("getran-interno.detran.df.gov.br")',

                cpuMetric: 'builtin:host.cpu.usage:splitBy("dt.entity.host"):avg',
                cpuMaxMetric: 'builtin:host.cpu.usage:splitBy("dt.entity.host"):max',
                memMetric: 'builtin:host.mem.usage:splitBy("dt.entity.host"):avg',

                // Banco de dados (MDA) — RESERVADO para o futuro relatório de BD
                dbMetric: 'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(20):names',
                dbTimeMetric: 'builtin:service.dbChildCallTime:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
                dbFailureMetric: 'builtin:service.dbconnections.failure:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',
                dbFailureRateMetric: 'builtin:service.dbconnections.failureRate:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(20):names',

                apdexMetric: 'builtin:apps.web.apdex.userType:filter(eq("User type","Real users")):splitBy():avg',
                sessionsMetric: 'builtin:apps.web.activeSessions:splitBy():sum',
                rageMetric: 'builtin:apps.web.event.count.rageClick:splitBy():sum',
                bounceMetric: 'builtin:apps.web.bouncedSessionRatio:splitBy():avg',
                startedSessionsMetric: 'builtin:apps.web.startedSessions:splitBy():sum',
                activeSessionsMetric: 'builtin:apps.web.activeSessions:splitBy():sum',
                geoMetric: 'builtin:apps.web.actionCount.summary:splitBy("dt.entity.geolocation"):sum',

                hasCrashes: false,
            },
        ],
    },
};

module.exports = { REPORT_CONFIGS };