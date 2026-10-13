/**
 * dynaLicenseRoutes.js
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dynaLicenseController');
const classicCtrl = require('../controllers/dynaClassicLicenseController');

router.get('/projects', ctrl.getProjects);
router.get('/projects/:uuid', ctrl.getProjectDetail);
router.get('/projects/:uuid/projection', ctrl.getProjectProjection);

router.get('/classic-projects', classicCtrl.getClassicProjects);

module.exports = router;