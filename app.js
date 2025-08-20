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

// Ruta principal para descargar todos los códigos - SOLO NÚMEROS LIMPIOS
app.post('/recetas', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = 'SELECT numero FROM recetas WHERE fechacreacion BETWEEN $1 AND $2';
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);

    // Limpiar y corregir números automáticamente
    const numeros = result.rows
      .map(r => r.numero)
      .map(numero => {
        // Convertir caracteres comunes mal escaneados a números
        let cleaned = numero
          .replace(/[&]/g, '6')      // & -> 6
          .replace(/[']/g, '7')      // ' -> 7  
          .replace(/[(]/g, '6')      // ( -> 6
          .replace(/[)]/g, '0')      // ) -> 0
          .replace(/[O]/g, '0')      // O -> 0
          .replace(/[I]/g, '1')      // I -> 1
          .replace(/[l]/g, '1')      // l -> 1
          .replace(/[S]/g, '5')      // S -> 5
          .replace(/[s]/g, '5')      // s -> 5
          .replace(/[B]/g, '8')      // B -> 8
          .replace(/[Z]/g, '2')      // Z -> 2
          .replace(/[G]/g, '6')      // G -> 6
          .replace(/[D]/g, '0')      // D -> 0
          .replace(/[^0-9]/g, '');   // Remover todo lo que no sea número después de las correcciones
        
        return cleaned;
      })
      .filter(numero => numero.length > 0) // Solo números válidos no vacíos
      .filter((numero, index, array) => array.indexOf(numero) === index); // Remover duplicados

    const txtContent = numeros.join('\n');

    res.setHeader('Content-disposition', 'attachment; filename=Codigos.txt');
    res.setHeader('Content-type', 'text/plain');
    res.write(txtContent, () => {
      res.end();
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener las recetas');
  }
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

// Ruta para descargar códigos APROSS (empiezan por 9) - NÚMEROS CORREGIDOS
app.post('/recetas-apross', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  let query = `SELECT numero FROM recetas 
               WHERE fechacreacion BETWEEN $1 AND $2 
               AND numero LIKE '9%'`;
  const params = [startDate, endDate];

  if (sucursal && sucursal !== 'all') {
    query += ' AND sucursales = $3';
    params.push(sucursal);
  }

  try {
    const result = await pool.query(query, params);
    
    // Limpiar y corregir números automáticamente
    const numeros = result.rows
      .map(r => r.numero)
      .map(numero => {
        // Convertir caracteres comunes mal escaneados a números
        let cleaned = numero
          .replace(/[&]/g, '6')      // & -> 6
          .replace(/[']/g, '7')      // ' -> 7  
          .replace(/[(]/g, '6')      // ( -> 6
          .replace(/[)]/g, '0')      // ) -> 0
          .replace(/[O]/g, '0')      // O -> 0
          .replace(/[I]/g, '1')      // I -> 1
          .replace(/[l]/g, '1')      // l -> 1
          .replace(/[S]/g, '5')      // S -> 5
          .replace(/[s]/g, '5')      // s -> 5
          .replace(/[B]/g, '8')      // B -> 8
          .replace(/[Z]/g, '2')      // Z -> 2
          .replace(/[G]/g, '6')      // G -> 6
          .replace(/[D]/g, '0')      // D -> 0
          .replace(/[^0-9]/g, '');   // Remover todo lo que no sea número después de las correcciones
        
        return cleaned;
      })
      .filter(numero => numero.length > 0 && numero.startsWith('9')) // Solo números válidos que empiecen por 9
      .filter((numero, index, array) => array.indexOf(numero) === index); // Remover duplicados

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

// Ruta para descargar códigos PAMI (empiezan por 8) - NÚMEROS CORREGIDOS
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
    
    // Limpiar y corregir números automáticamente
    const numeros = result.rows
      .map(r => r.numero)
      .map(numero => {
        // Convertir caracteres comunes mal escaneados a números
        let cleaned = numero
          .replace(/[&]/g, '6')      // & -> 6
          .replace(/[']/g, '7')      // ' -> 7  
          .replace(/[(]/g, '6')      // ( -> 6
          .replace(/[)]/g, '0')      // ) -> 0
          .replace(/[O]/g, '0')      // O -> 0
          .replace(/[I]/g, '1')      // I -> 1
          .replace(/[l]/g, '1')      // l -> 1
          .replace(/[S]/g, '5')      // S -> 5
          .replace(/[s]/g, '5')      // s -> 5
          .replace(/[B]/g, '8')      // B -> 8
          .replace(/[Z]/g, '2')      // Z -> 2
          .replace(/[G]/g, '6')      // G -> 6
          .replace(/[D]/g, '0')      // D -> 0
          .replace(/[^0-9]/g, '');   // Remover todo lo que no sea número después de las correcciones
        
        return cleaned;
      })
      .filter(numero => numero.length > 0 && numero.startsWith('8')) // Solo números válidos que empiecen por 8
      .filter((numero, index, array) => array.indexOf(numero) === index); // Remover duplicados

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
               AND numero LIKE '9%'`;
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

// Nueva ruta para el dashboard
app.get('/dashboard', isAuthenticated, (req, res) => {
  res.render('dashboard');
});

// API para obtener datos históricos del dashboard
app.post('/dashboard-data', isAuthenticated, async (req, res) => {
  const { startDate, endDate, sucursal } = req.body;
  
  try {
    // Query base para obtener datos agrupados por día
    let baseQuery = `
      SELECT 
        fechacreacion::date as date,
        COUNT(*) as total,
        COUNT(CASE WHEN numero LIKE '9%' THEN 1 END) as apross,
        COUNT(CASE WHEN numero LIKE '8%' THEN 1 END) as pami
      FROM recetas 
      WHERE fechacreacion::date BETWEEN $1::date AND $2::date
    `;
    
    const params = [startDate, endDate];
    
    if (sucursal && sucursal !== 'all') {
      baseQuery += ' AND sucursales = $3';
      params.push(sucursal);
    }
    
    baseQuery += ' GROUP BY fechacreacion::date ORDER BY fechacreacion::date ASC';
    
    console.log('Dashboard Query:', baseQuery);
    console.log('Dashboard Params:', params);
    
    const result = await pool.query(baseQuery, params);
    
    console.log('Dashboard Result:', result.rows);
    
    // Formatear datos para Chart.js
    const data = result.rows.map(row => ({
      date: row.date,
      total: parseInt(row.total),
      apross: parseInt(row.apross),
      pami: parseInt(row.pami)
    }));
    
    // Obtener totales generales
    let totalsQuery = `
      SELECT 
        COUNT(*) as total_general,
        COUNT(CASE WHEN numero LIKE '9%' THEN 1 END) as total_apross,
        COUNT(CASE WHEN numero LIKE '8%' THEN 1 END) as total_pami
      FROM recetas 
      WHERE fechacreacion::date BETWEEN $1::date AND $2::date
    `;
    
    if (sucursal && sucursal !== 'all') {
      totalsQuery += ' AND sucursales = $3';
    }
    
    const totalsResult = await pool.query(totalsQuery, params);
    const totals = totalsResult.rows[0];
    
    console.log('Dashboard Totals:', totals);
    
    res.json({
      data: data,
      totals: {
        total: parseInt(totals.total_general),
        apross: parseInt(totals.total_apross),
        pami: parseInt(totals.total_pami)
      }
    });
    
  } catch (err) {
    console.error('Error en dashboard-data:', err);
    res.status(500).json({ error: 'Error al obtener datos del dashboard', details: err.message });
  }
});

// Ruta de prueba para verificar datos en la base
app.get('/test-data', isAuthenticated, async (req, res) => {
  try {
    // Verificar estructura de la tabla
    const tableInfo = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'recetas'
      ORDER BY ordinal_position;
    `);
    
    // Obtener algunas filas de ejemplo
    const sampleData = await pool.query('SELECT * FROM recetas LIMIT 5');
    
    // Contar total de registros
    const totalCount = await pool.query('SELECT COUNT(*) FROM recetas');
    
    // Contar por tipo de número
    const typeCount = await pool.query(`
      SELECT 
        COUNT(CASE WHEN numero LIKE '9%' THEN 1 END) as apross_count,
        COUNT(CASE WHEN numero LIKE '8%' THEN 1 END) as pami_count,
        COUNT(*) as total_count,
        MIN(fechacreacion) as min_date,
        MAX(fechacreacion) as max_date
      FROM recetas
    `);
    
    res.json({
      tableStructure: tableInfo.rows,
      sampleData: sampleData.rows,
      totalRecords: totalCount.rows[0].count,
      statistics: typeCount.rows[0]
    });
    
  } catch (err) {
    console.error('Error en test-data:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
