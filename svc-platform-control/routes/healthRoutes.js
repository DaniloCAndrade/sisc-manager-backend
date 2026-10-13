const express = require('express');
const router  = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    status:    'UP',
    service:   'svc-platform-control',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;