const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// Teen Patti is currently under development
router.post('/bet', auth, async (req, res) => {
  return res.status(503).json({
    success: false,
    status: 'UNDER_DEVELOPMENT',
    message: 'Teen Patti is currently under development. Cricket Exchange is fully operational.'
  });
});

router.get('/state', (req, res) => {
  return res.json({
    status: 'UNDER_DEVELOPMENT',
    message: 'Teen Patti is currently under development. Cricket Exchange is fully operational.'
  });
});

router.get('/active-bets', auth, async (req, res) => {
  return res.json([]);
});

router.get('/history', async (req, res) => {
  return res.json([]);
});

module.exports = router;
