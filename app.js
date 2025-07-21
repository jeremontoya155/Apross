require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pool = require('./db');
const pgSession = require('connect-pg-simple')(session);

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Para manejar solicitudes JSON

// Middleware para servir archivos estáticos
app.use(express.static('public'));

app.use(session({
  store: new pgSession({
    pool: pool,                // Conexión de la base de datos
    tableName: 'session'       // Nombre de la tabla de sesiones
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 días
}));

// Middleware para verificar si el usuario está autenticado
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  } else {
    res.redirect('/login');
  }
}

// Ruta de inicio
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Rutas
app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
  const user = result.rows[0];

  if (user) {
    req.session.user = user;
    res.redirect('/recetas');
  } else {
    res.send('Username or password incorrect');
  }
});

// Ruta para obtener las sucursales únicas
app.get('/sucursales', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT sucursales FROM recetas');
    const sucursales = result.rows.map(row => parseInt(row.sucursales, 10)).sort((a, b) => a - b);
    res.json(sucursales);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener las sucursales');
  }
});

app.get('/recetas', isAuthenticated, (req, res) => {
  res.render('recetas');
});

app.post('/recetas', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = 'SELECT numero FROM recetas WHERE fechacreacion BETWEEN $1 AND $2';
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  const result = await pool.query(query, params);

  const numeros = result.rows.map(r => r.numero);
  const txtContent = numeros.join('\n');

  res.setHeader('Content-disposition', 'attachment; filename=Codigos.txt');
  res.setHeader('Content-type', 'text/plain');
  res.write(txtContent, () => {
    res.end();
  });
});

// Nueva ruta para obtener la cantidad de recetas en un rango de fechas y sucursal específica
app.post('/recetas-count', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = 'SELECT COUNT(*) FROM recetas WHERE fechacreacion BETWEEN $1 AND $2';
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener la cantidad de recetas');
  }
});

// Nueva ruta para obtener el listado de recetas con detalles agrupados por día y sucursal
app.get('/listado', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sucursales, fechacreacion, COUNT(*) as cantidad 
      FROM recetas 
      GROUP BY sucursales, fechacreacion 
      ORDER BY fechacreacion DESC
    `);
    const recetas = result.rows;
    res.render('listado', { recetas });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener el listado de recetas');
  }
});

// Nueva ruta para filtrar recetas agrupadas por día y sucursal
app.post('/filter-recetas', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = `
    SELECT sucursales, fechacreacion, COUNT(*) as cantidad 
    FROM recetas 
    WHERE 1=1
  `;
  const params = [];

  if (startDate) {
    query += ' AND fechacreacion >= $' + (params.length + 1);
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND fechacreacion <= $' + (params.length + 1);
    params.push(endDate);
  }

  if (sucursal) {
    query += ' AND sucursales = $' + (params.length + 1);
    params.push(sucursal);
  }

  query += ' GROUP BY sucursales, fechacreacion ORDER BY fechacreacion DESC';

  try {
    const result = await pool.query(query, params);
    const recetas = result.rows;
    res.render('listado', { recetas });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al filtrar el listado de recetas');
  }
});

// Ruta para actualizar la sucursal de un lote de recetas
app.post('/update-lote', isAuthenticated, async (req, res) => {
  const { sucursalActual, fecha, nuevaSucursal } = req.body;
  const query = `
    UPDATE recetas 
    SET sucursales = $1 
    WHERE sucursales = $2 AND fechacreacion = $3
  `;
  const params = [nuevaSucursal, sucursalActual, fecha];

  try {
    await pool.query(query, params);
    res.redirect('/listado');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al actualizar el lote de recetas');
  }
});

// Ruta para eliminar un lote de recetas
app.post('/delete-lote', isAuthenticated, async (req, res) => {
  const { sucursal, fecha } = req.body;
  const query = `
    DELETE FROM recetas 
    WHERE sucursales = $1 AND fechacreacion = $2
  `;
  const params = [sucursal, fecha];

  try {
    await pool.query(query, params);
    res.redirect('/listado');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al eliminar el lote de recetas');
  }
});

// Ruta para cerrar sesión
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.send('Error al cerrar la sesión');
    }
    res.redirect('/login');
  });
});

// Ruta para descargar códigos APROSS (empiezan por 9 y contienen "apross")
app.post('/recetas-apross', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = `SELECT numero FROM recetas 
               WHERE fechacreacion BETWEEN $1 AND $2 
               AND numero LIKE '9%' 
               AND (sucursales ILIKE '%apross%' OR autorizacion ILIKE '%apross%')`;
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);
    const numeros = result.rows.map(r => r.numero);
    const txtContent = numeros.join('\n');

    res.setHeader('Content-disposition', 'attachment; filename=Codigos_APROSS.txt');
    res.setHeader('Content-type', 'text/plain');
    res.write(txtContent, () => {
      res.end();
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener códigos APROSS');
  }
});

// Ruta para descargar códigos PAMI (empiezan por 8)
app.post('/recetas-pami', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = `SELECT numero FROM recetas 
               WHERE fechacreacion BETWEEN $1 AND $2 
               AND numero LIKE '8%'`;
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);
    const numeros = result.rows.map(r => r.numero);
    const txtContent = numeros.join('\n');

    res.setHeader('Content-disposition', 'attachment; filename=Codigos_PAMI.txt');
    res.setHeader('Content-type', 'text/plain');
    res.write(txtContent, () => {
      res.end();
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener códigos PAMI');
  }
});

// Ruta para obtener la cantidad de códigos APROSS
app.post('/recetas-apross-count', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = `SELECT COUNT(*) FROM recetas 
               WHERE fechacreacion BETWEEN $1 AND $2 
               AND numero LIKE '9%' 
               AND (sucursales ILIKE '%apross%' OR autorizacion ILIKE '%apross%')`;
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener la cantidad de códigos APROSS');
  }
});

// Ruta para obtener la cantidad de códigos PAMI
app.post('/recetas-pami-count', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = `SELECT COUNT(*) FROM recetas 
               WHERE fechacreacion BETWEEN $1 AND $2 
               AND numero LIKE '8%'`;
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener la cantidad de códigos PAMI');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
