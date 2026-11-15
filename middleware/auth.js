const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'a7df1cecb1c78b4b7bab8261102f22ab98715c8877cccacc392786588d189e15';

const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

module.exports = authMiddleware;
