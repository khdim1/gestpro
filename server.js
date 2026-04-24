const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const PDFDocument = require('pdfkit');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

require('dotenv').config();

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gestpro_db',
    waitForConnections: true,
    connectionLimit: 10
};
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_2025';
const PORT = process.env.PORT || 3000;

let pool;

function fetchImage(url) {
    return new Promise((resolve, reject) => {
        if (url.startsWith('data:')) {
            const matches = url.match(/^data:([^;]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const buffer = Buffer.from(matches[2], 'base64');
                resolve(buffer);
            } else reject(new Error('Format data URL invalide'));
            return;
        }
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

async function initAndStart() {
    try {
        pool = await mysql.createPool(DB_CONFIG);
        const conn = await pool.getConnection();
        await conn.ping();
        conn.release();
        console.log('✅ Connecté à MySQL');

        // Création des tables (avec les nouvelles colonnes)
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('admin','user') DEFAULT 'user',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS settings (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            company_name VARCHAR(200),
            company_subtitle VARCHAR(200),
            company_activity TEXT,
            company_rc VARCHAR(100),
            company_address TEXT,
            company_phone VARCHAR(50),
            company_phone2 VARCHAR(50),
            company_email VARCHAR(100),
            logo_url TEXT,
            tax_rate DECIMAL(5,2) DEFAULT 20.00,
            low_stock_alert INT DEFAULT 5,
            currency VARCHAR(10) DEFAULT 'FCFA',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS categories (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            description TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, name)
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            contact_name VARCHAR(100),
            email VARCHAR(100),
            phone VARCHAR(50),
            address TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS products (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            sku VARCHAR(50) NOT NULL,
            barcode VARCHAR(100),
            name VARCHAR(200) NOT NULL,
            description TEXT,
            category_id INT,
            supplier_id INT,
            quantity INT DEFAULT 0,
            unit VARCHAR(20) DEFAULT 'pièce',
            reorder_level INT DEFAULT 5,
            buy_price DECIMAL(10,2) DEFAULT 0,
            sell_price DECIMAL(10,2) DEFAULT 0,
            location VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
            UNIQUE(user_id, sku),
            UNIQUE(user_id, barcode)
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS clients (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100),
            phone VARCHAR(50),
            address TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS sales (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            client_id INT,
            sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            total_amount DECIMAL(10,2) NOT NULL,
            discount DECIMAL(10,2) DEFAULT 0,
            tax DECIMAL(10,2) DEFAULT 0,
            final_amount DECIMAL(10,2) NOT NULL,
            payment_method ENUM('cash','card','transfer') DEFAULT 'cash',
            status ENUM('completed','pending','cancelled') DEFAULT 'completed',
            due_date DATE NULL,
            notes TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS sale_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sale_id INT NOT NULL,
            product_id INT NOT NULL,
            quantity INT NOT NULL,
            unit_price DECIMAL(10,2) NOT NULL,
            total_price DECIMAL(10,2) NOT NULL,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS payments (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sale_id INT NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            payment_method ENUM('cash','card','transfer') DEFAULT 'cash',
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS cash_register (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            transaction_type ENUM('sale','purchase','expense','withdrawal','deposit','payment') NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            description VARCHAR(255),
            reference_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS stock_movements (
            id INT PRIMARY KEY AUTO_INCREMENT,
            product_id INT NOT NULL,
            user_id INT NOT NULL,
            type ENUM('purchase','sale','adjustment','return') NOT NULL,
            quantity_change INT NOT NULL,
            quantity_before INT NOT NULL,
            quantity_after INT NOT NULL,
            reference VARCHAR(100),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS proforma_invoices (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            proforma_number VARCHAR(50) NOT NULL,
            client_name VARCHAR(200),
            client_email VARCHAR(100),
            client_phone VARCHAR(50),
            client_address TEXT,
            issue_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            valid_until DATE,
            subtotal DECIMAL(10,2) NOT NULL,
            tax DECIMAL(10,2) DEFAULT 0,
            discount DECIMAL(10,2) DEFAULT 0,
            total DECIMAL(10,2) NOT NULL,
            notes TEXT,
            status ENUM('draft','sent','accepted','rejected') DEFAULT 'draft',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS proforma_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            proforma_id INT NOT NULL,
            description VARCHAR(500) NOT NULL,
            quantity INT NOT NULL,
            unit_price DECIMAL(10,2) NOT NULL,
            total_price DECIMAL(10,2) NOT NULL,
            FOREIGN KEY (proforma_id) REFERENCES proforma_invoices(id) ON DELETE CASCADE
        )`);

        // Ajout des colonnes pour settings (compatible MySQL < 8.0.29)
try { await pool.query(`ALTER TABLE settings ADD COLUMN company_subtitle VARCHAR(200)`); } catch(e) { if(e.code !== 'ER_DUP_FIELDNAME') console.warn(e); }
try { await pool.query(`ALTER TABLE settings ADD COLUMN company_activity TEXT`); } catch(e) { if(e.code !== 'ER_DUP_FIELDNAME') console.warn(e); }
try { await pool.query(`ALTER TABLE settings ADD COLUMN company_rc VARCHAR(100)`); } catch(e) { if(e.code !== 'ER_DUP_FIELDNAME') console.warn(e); }
try { await pool.query(`ALTER TABLE settings ADD COLUMN company_phone2 VARCHAR(50)`); } catch(e) { if(e.code !== 'ER_DUP_FIELDNAME') console.warn(e); }

        console.log('✅ Tables prêtes');
        app.listen(PORT, () => console.log(`🚀 Serveur sur http://localhost:${PORT}`));
    } catch (err) {
        console.error('❌ Erreur critique :', err.message);
        process.exit(1);
    }
}

const authenticate = async (req, res, next) => {
    let token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token && req.query.token) token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Non autorisé' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await pool.query('SELECT id, name, email, role FROM users WHERE id = ?', [decoded.userId]);
        if (rows.length === 0) throw new Error();
        req.user = rows[0];
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token invalide' });
    }
};

// ========== ROUTES AUTH ==========
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6)
        return res.status(400).json({ error: 'Champs invalides (mot de passe min 6)' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        const [result] = await pool.query(
            'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
            [name, email, hashed]
        );
        await pool.query(
            `INSERT INTO settings (user_id, company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [result.insertId, 'Mon Entreprise', '', '', '', '', '', '', '', '', 20, 5, 'FCFA']
        );
        res.status(201).json({ message: 'Utilisateur créé' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') res.status(400).json({ error: 'Email déjà utilisé' });
        else res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(401).json({ error: 'Identifiants invalides' });
        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });
        const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ========== ROUTES CLIENTS ==========
app.get('/api/clients', authenticate, async (req, res) => {
    const { search } = req.query;
    let query = 'SELECT * FROM clients WHERE user_id=?';
    const params = [req.user.id];
    if (search) { query += ' AND name LIKE ?'; params.push(`%${search}%`); }
    query += ' ORDER BY name';
    const [rows] = await pool.query(query, params);
    res.json(rows);
});
app.post('/api/clients', authenticate, async (req, res) => {
    const { name, email, phone, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    const [result] = await pool.query(
        'INSERT INTO clients (user_id, name, email, phone, address) VALUES (?,?,?,?,?)',
        [req.user.id, name, email, phone, address]
    );
    res.status(201).json({ id: result.insertId, name, email, phone, address });
});
app.put('/api/clients/:id', authenticate, async (req, res) => {
    const { name, email, phone, address } = req.body;
    await pool.query('UPDATE clients SET name=?, email=?, phone=?, address=? WHERE id=? AND user_id=?',
        [name, email, phone, address, req.params.id, req.user.id]);
    res.json({ message: 'OK' });
});
app.delete('/api/clients/:id', authenticate, async (req, res) => {
    await pool.query('DELETE FROM clients WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ message: 'OK' });
});

// ========== ROUTES CATEGORIES ==========
app.get('/api/categories', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM categories WHERE user_id=? ORDER BY name', [req.user.id]);
    res.json(rows);
});
app.post('/api/categories', authenticate, async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    try {
        const [result] = await pool.query('INSERT INTO categories (user_id, name, description) VALUES (?,?,?)', [req.user.id, name, description]);
        res.status(201).json({ id: result.insertId, name, description });
    } catch (err) { res.status(400).json({ error: 'Catégorie existe déjà' }); }
});
app.put('/api/categories/:id', authenticate, async (req, res) => {
    const { name, description } = req.body;
    await pool.query('UPDATE categories SET name=?, description=? WHERE id=? AND user_id=?', [name, description, req.params.id, req.user.id]);
    res.json({ message: 'OK' });
});
app.delete('/api/categories/:id', authenticate, async (req, res) => {
    await pool.query('DELETE FROM categories WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ message: 'OK' });
});

// ========== ROUTES PRODUITS ==========
app.get('/api/products', authenticate, async (req, res) => {
    const [rows] = await pool.query(`
        SELECT p.*, c.name as category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.user_id = ? ORDER BY p.name`, [req.user.id]);
    res.json(rows);
});
app.post('/api/products', authenticate, async (req, res) => {
    const { sku, barcode, name, description, category_id, category_name, supplier_id, quantity, unit, reorder_level, buy_price, sell_price, location } = req.body;
    if (!sku || !name) return res.status(400).json({ error: 'SKU et nom requis' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        let finalCatId = category_id;
        if (category_name && category_name.trim() !== '') {
            let [cat] = await connection.query('SELECT id FROM categories WHERE user_id=? AND name=?', [req.user.id, category_name]);
            if (cat.length === 0) {
                const [catResult] = await connection.query('INSERT INTO categories (user_id, name) VALUES (?,?)', [req.user.id, category_name]);
                finalCatId = catResult.insertId;
            } else {
                finalCatId = cat[0].id;
            }
        }
        const supId = supplier_id ? parseInt(supplier_id) : null;
        const [result] = await connection.query(`
            INSERT INTO products (user_id, sku, barcode, name, description, category_id, supplier_id, quantity, unit, reorder_level, buy_price, sell_price, location)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [req.user.id, sku, barcode || null, name, description || '', finalCatId || null, supId, quantity || 0, unit || 'pièce', reorder_level || 5, buy_price || 0, sell_price || 0, location || null]);
        await connection.commit();
        res.status(201).json({ id: result.insertId });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur création produit:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'SKU ou code barre déjà utilisé' });
        res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    } finally {
        connection.release();
    }
});
app.put('/api/products/:id', authenticate, async (req, res) => {
    const { sku, barcode, name, description, category_id, category_name, supplier_id, quantity, unit, reorder_level, buy_price, sell_price, location } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        let finalCatId = category_id;
        if (category_name && category_name.trim() !== '') {
            let [cat] = await connection.query('SELECT id FROM categories WHERE user_id=? AND name=?', [req.user.id, category_name]);
            if (cat.length === 0) {
                const [catResult] = await connection.query('INSERT INTO categories (user_id, name) VALUES (?,?)', [req.user.id, category_name]);
                finalCatId = catResult.insertId;
            } else {
                finalCatId = cat[0].id;
            }
        }
        const supId = supplier_id ? parseInt(supplier_id) : null;
        await connection.query(`
            UPDATE products SET sku=?, barcode=?, name=?, description=?, category_id=?, supplier_id=?, quantity=?, unit=?, reorder_level=?, buy_price=?, sell_price=?, location=?
            WHERE id=? AND user_id=?`,
            [sku, barcode, name, description, finalCatId || null, supId, quantity, unit, reorder_level, buy_price, sell_price, location, req.params.id, req.user.id]);
        await connection.commit();
        res.json({ message: 'Mis à jour' });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur modification produit:', err);
        res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    } finally {
        connection.release();
    }
});
app.delete('/api/products/:id', authenticate, async (req, res) => {
    await pool.query('DELETE FROM products WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ message: 'Supprimé' });
});
app.get('/api/products/barcode/:code', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM products WHERE user_id=? AND barcode=?', [req.user.id, req.params.code]);
    if (rows.length === 0) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json(rows[0]);
});
app.get('/api/products/search', authenticate, async (req, res) => {
    const { q, lowStock } = req.query;
    let query = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.user_id = ?';
    const params = [req.user.id];
    if (q) {
        query += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (lowStock === 'true') {
        query += ' AND p.quantity <= p.reorder_level';
    }
    query += ' ORDER BY p.name';
    const [rows] = await pool.query(query, params);
    res.json(rows);
});

// ========== VENTES ==========
app.post('/api/sales', authenticate, async (req, res) => {
    const { client_name, client_email, client_phone, client_address, items, discount, payment_method, status, due_date } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'Aucun produit' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        let client_id = null;
        if (client_name && client_name.trim() !== '') {
            let [existing] = await connection.query('SELECT id FROM clients WHERE user_id=? AND name=?', [req.user.id, client_name]);
            if (existing.length > 0) client_id = existing[0].id;
            else {
                const [result] = await connection.query(
                    'INSERT INTO clients (user_id, name, email, phone, address) VALUES (?,?,?,?,?)',
                    [req.user.id, client_name, client_email || null, client_phone || null, client_address || null]
                );
                client_id = result.insertId;
            }
        }
        let subtotal = 0;
        for (let item of items) {
            const [prod] = await connection.query('SELECT quantity FROM products WHERE id=? AND user_id=? FOR UPDATE', [item.product_id, req.user.id]);
            if (prod.length === 0) throw new Error(`Produit ${item.product_id} inexistant`);
            if (prod[0].quantity < item.quantity) throw new Error(`Stock insuffisant`);
            item.total_price = item.unit_price * item.quantity;
            subtotal += item.total_price;
        }
        const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [req.user.id]);
        const tax_rate = settings[0]?.tax_rate || 20;
        const tax = subtotal * (tax_rate / 100);
        const final_amount = subtotal + tax - (discount || 0);
        const finalStatus = status === 'pending' ? 'pending' : 'completed';
        const [saleResult] = await connection.query(
            `INSERT INTO sales (user_id, client_id, total_amount, discount, tax, final_amount, payment_method, status, due_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, client_id, subtotal, discount || 0, tax, final_amount, payment_method || 'cash', finalStatus, due_date || null]
        );
        const sale_id = saleResult.insertId;
        for (let item of items) {
            await connection.query(
                `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price) VALUES (?,?,?,?,?)`,
                [sale_id, item.product_id, item.quantity, item.unit_price, item.total_price]
            );
            const [prodBefore] = await connection.query('SELECT quantity FROM products WHERE id=? FOR UPDATE', [item.product_id]);
            const oldQty = prodBefore[0].quantity;
            const newQty = oldQty - item.quantity;
            await connection.query('UPDATE products SET quantity=? WHERE id=?', [newQty, item.product_id]);
            await connection.query(
                `INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, reference)
                 VALUES (?, ?, 'sale', ?, ?, ?, ?)`,
                [item.product_id, req.user.id, -item.quantity, oldQty, newQty, `VENTE #${sale_id}`]
            );
        }
        if (finalStatus === 'completed') {
            await connection.query(`INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)`, [sale_id, final_amount, payment_method || 'cash']);
            await connection.query(`INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) VALUES (?, 'sale', ?, ?, ?)`, [req.user.id, final_amount, `Vente #${sale_id}`, sale_id]);
        }
        await connection.commit();
        res.status(201).json({ sale_id, final_amount, status: finalStatus });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});
app.get('/api/sales', authenticate, async (req, res) => {
    const { client_name, status, start_date, end_date } = req.query;
    let query = `SELECT s.*, c.name as client_name FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id = ?`;
    const params = [req.user.id];
    if (client_name) { query += ` AND c.name LIKE ?`; params.push(`%${client_name}%`); }
    if (status) { query += ` AND s.status = ?`; params.push(status); }
    if (start_date) { query += ` AND DATE(s.sale_date) >= ?`; params.push(start_date); }
    if (end_date) { query += ` AND DATE(s.sale_date) <= ?`; params.push(end_date); }
    query += ` ORDER BY s.sale_date DESC LIMIT 500`;
    const [rows] = await pool.query(query, params);
    res.json(rows);
});
app.post('/api/sales/:id/payment', authenticate, async (req, res) => {
    const { amount, payment_method } = req.body;
    const saleId = req.params.id;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [saleRows] = await connection.query('SELECT * FROM sales WHERE id=? AND user_id=? FOR UPDATE', [saleId, req.user.id]);
        if (saleRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Facture non trouvée' });
        }
        const sale = saleRows[0];
        if (sale.status === 'completed') {
            await connection.rollback();
            return res.status(400).json({ error: 'Cette facture est déjà réglée' });
        }
        const [paidRows] = await connection.query('SELECT COALESCE(SUM(amount),0) as total_paid FROM payments WHERE sale_id=?', [saleId]);
        const totalPaid = parseFloat(paidRows[0].total_paid);
        const remaining = sale.final_amount - totalPaid;
        if (amount > remaining) {
            await connection.rollback();
            return res.status(400).json({ error: `Le montant dépasse le reste à payer (${remaining} FCFA)` });
        }
        await connection.query(
            'INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)',
            [saleId, amount, payment_method || 'cash']
        );
        await connection.query(
            'INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) VALUES (?, "deposit", ?, ?, ?)',
            [req.user.id, amount, `Règlement facture #${saleId}`, saleId]
        );
        const newTotalPaid = totalPaid + amount;
        let newStatus = sale.status;
        if (newTotalPaid >= sale.final_amount - 0.01) {
            await connection.query('UPDATE sales SET status = "completed" WHERE id = ?', [saleId]);
            newStatus = 'completed';
        }
        await connection.commit();
        res.json({ message: 'Règlement enregistré', remaining: sale.final_amount - newTotalPaid, status: newStatus });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur paiement:', err);
        res.status(500).json({ error: 'Erreur interne lors du règlement' });
    } finally {
        connection.release();
    }
});

// ========== CAISSE, INVENTAIRE, RAPPORTS ==========
app.get('/api/cash-register', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM cash_register WHERE user_id=? ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    res.json(rows);
});
app.post('/api/cash-register', authenticate, async (req, res) => {
    const { transaction_type, amount, description } = req.body;
    if (!transaction_type || !amount) return res.status(400).json({ error: 'Type et montant requis' });
    const allowed = ['sale', 'purchase', 'expense', 'withdrawal', 'deposit', 'payment'];
    if (!allowed.includes(transaction_type)) return res.status(400).json({ error: 'Type invalide' });
    await pool.query(
        'INSERT INTO cash_register (user_id, transaction_type, amount, description) VALUES (?,?,?,?)',
        [req.user.id, transaction_type, amount, description]
    );
    res.status(201).json({ message: 'Transaction ajoutée' });
});
app.get('/api/cash-register/summary', authenticate, async (req, res) => {
    const [entrees] = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM cash_register 
         WHERE user_id = ? AND transaction_type IN ('sale', 'deposit', 'payment')`,
        [req.user.id]
    );
    const [sorties] = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM cash_register 
         WHERE user_id = ? AND transaction_type IN ('purchase', 'expense', 'withdrawal')`,
        [req.user.id]
    );
    res.json({ entries: entrees[0].total, expenses: sorties[0].total, balance: entrees[0].total - sorties[0].total });
});
app.post('/api/inventory/adjust', authenticate, async (req, res) => {
    const { product_id, new_quantity, reason } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [prod] = await connection.query('SELECT quantity FROM products WHERE id=? AND user_id=? FOR UPDATE', [product_id, req.user.id]);
        if (prod.length === 0) throw new Error('Produit non trouvé');
        const oldQty = prod[0].quantity;
        const change = new_quantity - oldQty;
        await connection.query('UPDATE products SET quantity=? WHERE id=?', [new_quantity, product_id]);
        await connection.query(`INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, notes) VALUES (?, ?, 'adjustment', ?, ?, ?, ?)`, [product_id, req.user.id, change, oldQty, new_quantity, reason || 'Ajustement manuel']);
        await connection.commit();
        res.json({ message: 'Stock ajusté', oldQty, new_quantity });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});
app.get('/api/inventory/movements', authenticate, async (req, res) => {
    const [rows] = await pool.query(`SELECT sm.*, p.name as product_name FROM stock_movements sm JOIN products p ON sm.product_id = p.id WHERE sm.user_id = ? ORDER BY sm.created_at DESC LIMIT 300`, [req.user.id]);
    res.json(rows);
});
app.get('/api/inventory/global', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT id, sku, name, quantity, unit, reorder_level FROM products WHERE user_id = ? ORDER BY name', [req.user.id]);
    res.json(rows);
});
app.get('/api/reports/dashboard', authenticate, async (req, res) => {
    const [totalProducts] = await pool.query('SELECT COUNT(*) as count FROM products WHERE user_id=?', [req.user.id]);
    const [lowStock] = await pool.query('SELECT COUNT(*) as count FROM products WHERE user_id=? AND quantity <= reorder_level', [req.user.id]);
    const [inventoryValue] = await pool.query('SELECT SUM(quantity * buy_price) as value FROM products WHERE user_id=?', [req.user.id]);
    const [todaySales] = await pool.query(`SELECT COALESCE(SUM(final_amount),0) as total FROM sales WHERE user_id=? AND DATE(sale_date) = CURDATE() AND status='completed'`, [req.user.id]);
    const [monthSales] = await pool.query(`SELECT COALESCE(SUM(final_amount),0) as total FROM sales WHERE user_id=? AND MONTH(sale_date)=MONTH(CURDATE()) AND YEAR(sale_date)=YEAR(CURDATE())`, [req.user.id]);
    const [topProducts] = await pool.query(`SELECT p.name, SUM(si.quantity) as qte FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id WHERE s.user_id=? AND s.status='completed' GROUP BY p.id ORDER BY qte DESC LIMIT 5`, [req.user.id]);
    const [recentSales] = await pool.query(`SELECT s.id, s.final_amount, s.sale_date, c.name as client_name FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id=? ORDER BY s.sale_date DESC LIMIT 5`, [req.user.id]);
    res.json({ totalProducts: totalProducts[0].count, lowStock: lowStock[0].count, inventoryValue: inventoryValue[0].value || 0, todaySales: todaySales[0].total, monthSales: monthSales[0].total, topProducts, recentSales });
});
app.get('/api/reports/sales-by-period', authenticate, async (req, res) => {
    const { period } = req.query;
    let groupBy = period === 'week' ? 'DATE(sale_date)' : (period === 'month' ? 'DATE_FORMAT(sale_date, "%Y-%m-%d")' : 'DATE_FORMAT(sale_date, "%Y-%m")');
    const [rows] = await pool.query(`SELECT ${groupBy} as date, SUM(final_amount) as total FROM sales WHERE user_id=? AND status='completed' GROUP BY date ORDER BY date DESC LIMIT 30`, [req.user.id]);
    res.json(rows);
});

// ========== PARAMÈTRES (avec nouveaux champs) ==========
app.get('/api/settings', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM settings WHERE user_id=?', [req.user.id]);
    if (rows.length === 0) {
        await pool.query(
            `INSERT INTO settings (user_id, company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, 'Mon Entreprise', '', '', '', '', '', '', '', '', 20, 5, 'FCFA']
        );
        return res.json({ company_name: 'Mon Entreprise', company_subtitle: '', company_activity: '', company_rc: '', company_address: '', company_phone: '', company_phone2: '', company_email: '', logo_url: '', tax_rate: 20, low_stock_alert: 5, currency: 'FCFA' });
    }
    res.json(rows[0]);
});
app.put('/api/settings', authenticate, async (req, res) => {
    const { company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency } = req.body;
    await pool.query(
        `UPDATE settings SET company_name=?, company_subtitle=?, company_activity=?, company_rc=?, company_address=?, company_phone=?, company_phone2=?, company_email=?, logo_url=?, tax_rate=?, low_stock_alert=?, currency=? WHERE user_id=?`,
        [company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency, req.user.id]
    );
    res.json({ message: 'Paramètres mis à jour' });
});

app.get('/api/history', authenticate, async (req, res) => {
    const [sales] = await pool.query(`SELECT 'sale' as type, s.id, s.final_amount as amount, s.sale_date as date, c.name as client_name, s.status FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id = ? ORDER BY s.sale_date DESC LIMIT 100`, [req.user.id]);
    const [movements] = await pool.query(`SELECT 'stock' as type, sm.id, sm.quantity_change as amount, sm.created_at as date, p.name as product_name, sm.type as movement_type FROM stock_movements sm JOIN products p ON sm.product_id = p.id WHERE sm.user_id = ? ORDER BY sm.created_at DESC LIMIT 100`, [req.user.id]);
    const history = [...sales, ...movements].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 100);
    res.json(history);
});

// ========== PROFORMA ==========
async function getNextProformaNumber(userId) {
    const [rows] = await pool.query('SELECT proforma_number FROM proforma_invoices WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    let lastNumber = 0;
    if (rows.length > 0) {
        const match = rows[0].proforma_number.match(/PROF-(\d+)/);
        if (match) lastNumber = parseInt(match[1]);
    }
    return `PROF-${String(lastNumber + 1).padStart(4, '0')}`;
}
app.post('/api/proforma', authenticate, async (req, res) => {
    const { client_name, client_email, client_phone, client_address, items, discount, valid_until, notes } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'Aucun article' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        let subtotal = 0;
        for (let item of items) {
            item.total_price = item.quantity * item.unit_price;
            subtotal += item.total_price;
        }
        const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [req.user.id]);
        const tax_rate = settings[0]?.tax_rate || 20;
        const tax = subtotal * (tax_rate / 100);
        const total = subtotal + tax - (discount || 0);
        const proformaNumber = await getNextProformaNumber(req.user.id);
        const [result] = await connection.query(
            `INSERT INTO proforma_invoices (user_id, proforma_number, client_name, client_email, client_phone, client_address, subtotal, tax, discount, total, valid_until, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
            [req.user.id, proformaNumber, client_name || '', client_email || '', client_phone || '', client_address || '', subtotal, tax, discount || 0, total, valid_until || null, notes || '']
        );
        const proformaId = result.insertId;
        for (let item of items) {
            await connection.query(
                `INSERT INTO proforma_items (proforma_id, description, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)`,
                [proformaId, item.description, item.quantity, item.unit_price, item.total_price]
            );
        }
        await connection.commit();
        res.status(201).json({ id: proformaId, number: proformaNumber });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Erreur création proforma' });
    } finally {
        connection.release();
    }
});
app.get('/api/proforma', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM proforma_invoices WHERE user_id = ? ORDER BY issue_date DESC', [req.user.id]);
    res.json(rows);
});
app.delete('/api/proforma/:id', authenticate, async (req, res) => {
    await pool.query('DELETE FROM proforma_invoices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Proforma supprimée' });
});
app.get('/api/proforma/:id/pdf', authenticate, async (req, res) => {
    try {
        const proformaId = req.params.id;
        const [invoiceRows] = await pool.query('SELECT * FROM proforma_invoices WHERE id = ? AND user_id = ?', [proformaId, req.user.id]);
        if (invoiceRows.length === 0) return res.status(404).json({ error: 'Proforma non trouvée' });
        const invoice = invoiceRows[0];
        const [items] = await pool.query('SELECT * FROM proforma_items WHERE proforma_id = ?', [proformaId]);
        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', currency: 'FCFA' };
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=proforma_${invoice.proforma_number}.pdf`);
        doc.pipe(res);
        
        // Utiliser la même fonction d'en-tête que pour les factures
        let y = await drawCompanyHeader(doc, company);
        
        doc.fillColor('#3498db').fontSize(18).font('Helvetica-Bold').text(`FACTURE PROFORMA N° ${invoice.proforma_number}`, 50, y, { align: 'center' });
        y += 30;
        doc.fillColor('#ecf0f1').rect(50, y, 500, 80).fill();
        doc.fillColor('black').fontSize(10);
        doc.text(`Date d'émission : ${new Date(invoice.issue_date).toLocaleString()}`, 60, y + 10);
        doc.text(`Client : ${invoice.client_name || 'Client particulier'}`, 60, y + 25);
        if (invoice.client_email) doc.text(`Email : ${invoice.client_email}`, 60, y + 40);
        if (invoice.client_phone) doc.text(`Tél : ${invoice.client_phone}`, 60, y + 55);
        if (invoice.client_address) doc.text(`Adresse : ${invoice.client_address}`, 60, y + 70);
        if (invoice.valid_until) doc.text(`Valable jusqu'au : ${new Date(invoice.valid_until).toLocaleDateString()}`, 400, y + 10);
        y += 90;
        const tableTop = y;
        doc.fillColor('#2c3e50').rect(50, tableTop, 500, 20).fill();
        doc.fillColor('white').fontSize(10).font('Helvetica-Bold');
        doc.text('Description', 60, tableTop + 5);
        doc.text('Quantité', 250, tableTop + 5);
        doc.text('Prix unit.', 350, tableTop + 5);
        doc.text('Total', 450, tableTop + 5);
        let rowY = tableTop + 25;
        doc.fillColor('black').font('Helvetica');
        items.forEach(item => {
            doc.text(item.description, 60, rowY);
            doc.text(item.quantity.toString(), 250, rowY);
            doc.text(`${item.unit_price.toLocaleString()} ${company.currency}`, 350, rowY);
            doc.text(`${item.total_price.toLocaleString()} ${company.currency}`, 450, rowY);
            rowY += 20;
        });
        for (let i = 0; i <= items.length; i++) doc.lineWidth(0.5).strokeColor('#bdc3c7').moveTo(50, tableTop + 20 + i * 20).lineTo(550, tableTop + 20 + i * 20).stroke();
        rowY += 10;
        doc.font('Helvetica-Bold');
        doc.text(`Sous-total : ${invoice.subtotal.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.text(`TVA (20%) : ${invoice.tax.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.text(`Remise : ${invoice.discount.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.fillColor('#3498db').fontSize(12).text(`Total : ${invoice.total.toLocaleString()} ${company.currency}`, 350, rowY, { bold: true });
        doc.fillColor('#2c3e50').rect(50, 750, 500, 30).fill();
        doc.fillColor('white').fontSize(8).text('Document non contractuel - Devis valant accord', 50, 760, { align: 'center' });
        doc.end();
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur génération proforma' }); }
});
// ========== FACTURE, BON DE COMMANDE, BORDEREAU DE LIVRAISON (avec en-tête enrichi) ==========
async function drawCompanyHeader(doc, company, startY = 45) {
    let logoWidth = 0;
    if (company.logo_url && company.logo_url.trim() !== '') {
        try { 
            const logoBuffer = await fetchImage(company.logo_url); 
            doc.image(logoBuffer, 50, startY, { width: 100 }); 
            logoWidth = 120; 
        } catch (err) {}
    }
    const headerX = 50 + logoWidth;
    const headerWidth = 500 - logoWidth;
    const headerY = startY;
    const headerHeight = 110;
    doc.rect(headerX, headerY, headerWidth, headerHeight).fill('#2c3e50');
    doc.fillColor('white');
    doc.fontSize(18).font('Helvetica-Bold').text(company.company_name, headerX + 10, headerY + 10, { width: headerWidth - 20, align: 'center' });
    let currentY = headerY + 35;
    if (company.company_subtitle && company.company_subtitle.trim() !== '') {
        doc.fontSize(10).font('Helvetica').text(company.company_subtitle, headerX + 10, currentY, { width: headerWidth - 20, align: 'center' });
        currentY += 15;
    }
    if (company.company_activity && company.company_activity.trim() !== '') {
        doc.fontSize(9).font('Helvetica-Oblique').text(company.company_activity, headerX + 10, currentY, { width: headerWidth - 20, align: 'center' });
        currentY += 15;
    }
    if (company.company_rc && company.company_rc.trim() !== '') {
        doc.fontSize(8).font('Helvetica').text(company.company_rc, headerX + 10, currentY, { width: headerWidth - 20, align: 'center' });
        currentY += 15;
    }
    if (company.company_address && company.company_address.trim() !== '') {
        doc.fontSize(9).font('Helvetica').text(company.company_address, headerX + 10, currentY, { width: headerWidth - 20, align: 'center' });
        currentY += 15;
    }
    let phoneLine = '';
    if (company.company_phone) phoneLine += `Tél : ${company.company_phone}`;
    if (company.company_phone2) phoneLine += ` // ${company.company_phone2}`;
    if (phoneLine) {
        doc.fontSize(9).font('Helvetica').text(phoneLine, headerX + 10, currentY, { width: headerWidth - 20, align: 'center' });
    }
    return Math.max(startY + headerHeight, startY + (logoWidth ? 60 : 0)) + 20;
}

// Facture
app.get('/api/sales/:id/invoice', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(
            `SELECT s.*, c.name as client_name, c.email as client_email, c.address as client_address
             FROM sales s LEFT JOIN clients c ON s.client_id = c.id
             WHERE s.id = ? AND s.user_id = ?`,
            [saleId, req.user.id]
        );
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];
        const [items] = await pool.query(
            `SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`,
            [saleId]
        );
        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', company_address: '', company_phone: '', company_phone2: '', company_subtitle: '', company_activity: '', company_rc: '', currency: 'FCFA' };
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=facture_${saleId}.pdf`);
        doc.pipe(res);
        // Entête personnalisée
        let y = await drawCompanyHeader(doc, company);
        doc.fillColor('#3498db').fontSize(18).font('Helvetica-Bold').text(`FACTURE N° ${saleId}`, 50, y, { align: 'center' });
        y += 30;
        doc.fillColor('#ecf0f1').rect(50, y, 500, 80).fill();
        doc.fillColor('black').fontSize(10);
        doc.text(`Date : ${new Date(sale.sale_date).toLocaleString()}`, 60, y + 10);
        doc.text(`Client : ${sale.client_name || 'Client particulier'}`, 60, y + 25);
        if (sale.client_email) doc.text(`Email : ${sale.client_email}`, 60, y + 40);
        if (sale.client_address) doc.text(`Adresse : ${sale.client_address}`, 60, y + 55);
        doc.text(`Statut : ${sale.status === 'completed' ? '✓ Payée' : '⏳ En attente'}`, 400, y + 10);
        y += 90;
        const tableTop = y;
        doc.fillColor('#2c3e50').rect(50, tableTop, 500, 20).fill();
        doc.fillColor('white').fontSize(10).font('Helvetica-Bold');
        doc.text('Produit', 60, tableTop + 5);
        doc.text('Quantité', 250, tableTop + 5);
        doc.text('Prix unit.', 350, tableTop + 5);
        doc.text('Total', 450, tableTop + 5);
        let rowY = tableTop + 25;
        doc.fillColor('black').font('Helvetica');
        items.forEach(item => {
            doc.text(item.product_name, 60, rowY);
            doc.text(item.quantity.toString(), 250, rowY);
            doc.text(`${item.unit_price.toLocaleString()} ${company.currency}`, 350, rowY);
            doc.text(`${item.total_price.toLocaleString()} ${company.currency}`, 450, rowY);
            rowY += 20;
        });
        for (let i = 0; i <= items.length; i++) doc.lineWidth(0.5).strokeColor('#bdc3c7').moveTo(50, tableTop + 20 + i * 20).lineTo(550, tableTop + 20 + i * 20).stroke();
        rowY += 10;
        doc.font('Helvetica-Bold');
        doc.text(`Sous-total : ${sale.total_amount.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.text(`TVA (20%) : ${sale.tax.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.text(`Remise : ${sale.discount.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.fillColor('#3498db').fontSize(12).text(`Total à payer : ${sale.final_amount.toLocaleString()} ${company.currency}`, 350, rowY, { bold: true });
        doc.fillColor('#2c3e50').rect(50, 750, 500, 30).fill();
        doc.fillColor('white').fontSize(8).text('Merci de votre confiance', 50, 760, { align: 'center' });
        doc.end();
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur génération facture' }); }
});

// Bon de commande (identique à facture mais titre différent)
app.get('/api/sales/:id/order', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(
            `SELECT s.*, c.name as client_name, c.email as client_email, c.address as client_address
             FROM sales s LEFT JOIN clients c ON s.client_id = c.id
             WHERE s.id = ? AND s.user_id = ?`,
            [saleId, req.user.id]
        );
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];
        const [items] = await pool.query(
            `SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`,
            [saleId]
        );
        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', currency: 'FCFA' };
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=bon_commande_${saleId}.pdf`);
        doc.pipe(res);
        let y = await drawCompanyHeader(doc, company);
        doc.fillColor('#3498db').fontSize(18).font('Helvetica-Bold').text(`BON DE COMMANDE N° ${saleId}`, 50, y, { align: 'center' });
        y += 30;
        doc.fillColor('#ecf0f1').rect(50, y, 500, 80).fill();
        doc.fillColor('black').fontSize(10);
        doc.text(`Date : ${new Date(sale.sale_date).toLocaleString()}`, 60, y + 10);
        doc.text(`Client : ${sale.client_name || 'Client particulier'}`, 60, y + 25);
        if (sale.client_email) doc.text(`Email : ${sale.client_email}`, 60, y + 40);
        if (sale.client_address) doc.text(`Adresse de livraison : ${sale.client_address}`, 60, y + 55);
        y += 90;
        const tableTop = y;
        doc.fillColor('#2c3e50').rect(50, tableTop, 500, 20).fill();
        doc.fillColor('white').fontSize(10).font('Helvetica-Bold');
        doc.text('Produit', 60, tableTop + 5);
        doc.text('Quantité', 250, tableTop + 5);
        doc.text('Prix unit.', 350, tableTop + 5);
        doc.text('Total', 450, tableTop + 5);
        let rowY = tableTop + 25;
        doc.fillColor('black').font('Helvetica');
        items.forEach(item => {
            doc.text(item.product_name, 60, rowY);
            doc.text(item.quantity.toString(), 250, rowY);
            doc.text(`${item.unit_price.toLocaleString()} ${company.currency}`, 350, rowY);
            doc.text(`${item.total_price.toLocaleString()} ${company.currency}`, 450, rowY);
            rowY += 20;
        });
        for (let i = 0; i <= items.length; i++) doc.lineWidth(0.5).strokeColor('#bdc3c7').moveTo(50, tableTop + 20 + i * 20).lineTo(550, tableTop + 20 + i * 20).stroke();
        rowY += 10;
        doc.font('Helvetica-Bold');
        doc.text(`Sous-total : ${sale.total_amount.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.text(`TVA (20%) : ${sale.tax.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.text(`Remise : ${sale.discount.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15; doc.fillColor('#3498db').fontSize(12).text(`Total : ${sale.final_amount.toLocaleString()} ${company.currency}`, 350, rowY, { bold: true });
        doc.fillColor('#2c3e50').rect(50, 750, 500, 30).fill();
        doc.fillColor('white').fontSize(8).text('Merci de votre commande', 50, 760, { align: 'center' });
        doc.end();
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur génération bon de commande' }); }
});

// Bordereau de livraison
app.get('/api/sales/:id/delivery', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(
            `SELECT s.*, c.name as client_name, c.email as client_email, c.address as client_address
             FROM sales s LEFT JOIN clients c ON s.client_id = c.id
             WHERE s.id = ? AND s.user_id = ?`,
            [saleId, req.user.id]
        );
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];
        const [items] = await pool.query(
            `SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`,
            [saleId]
        );
        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', currency: 'FCFA' };
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=bordereau_livraison_${saleId}.pdf`);
        doc.pipe(res);
        let y = await drawCompanyHeader(doc, company);
        doc.fillColor('#3498db').fontSize(18).font('Helvetica-Bold').text(`BORDEREAU DE LIVRAISON N° ${saleId}`, 50, y, { align: 'center' });
        y += 30;
        doc.fillColor('#ecf0f1').rect(50, y, 500, 80).fill();
        doc.fillColor('black').fontSize(10);
        doc.text(`Date de commande : ${new Date(sale.sale_date).toLocaleString()}`, 60, y + 10);
        doc.text(`Client : ${sale.client_name || 'Client particulier'}`, 60, y + 25);
        if (sale.client_email) doc.text(`Email : ${sale.client_email}`, 60, y + 40);
        if (sale.client_address) doc.text(`Adresse de livraison : ${sale.client_address}`, 60, y + 55);
        y += 90;
        const tableTop = y;
        doc.fillColor('#2c3e50').rect(50, tableTop, 500, 20).fill();
        doc.fillColor('white').fontSize(10).font('Helvetica-Bold');
        doc.text('Produit', 60, tableTop + 5);
        doc.text('Quantité', 250, tableTop + 5);
        doc.text('Remarque', 350, tableTop + 5);
        let rowY = tableTop + 25;
        doc.fillColor('black').font('Helvetica');
        items.forEach(item => {
            doc.text(item.product_name, 60, rowY);
            doc.text(item.quantity.toString(), 250, rowY);
            doc.text('', 350, rowY);
            rowY += 20;
        });
        for (let i = 0; i <= items.length; i++) doc.lineWidth(0.5).strokeColor('#bdc3c7').moveTo(50, tableTop + 20 + i * 20).lineTo(550, tableTop + 20 + i * 20).stroke();
        rowY += 30;
        doc.text(`Date de livraison : _____________`, 50, rowY);
        doc.text(`Signature du client : _____________`, 300, rowY);
        doc.fillColor('#2c3e50').rect(50, 750, 500, 30).fill();
        doc.fillColor('white').fontSize(8).text('Bon de livraison à conserver', 50, 760, { align: 'center' });
        doc.end();
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur génération bordereau de livraison' }); }
});

// ========== SERVEUR FRONTEND AVEC ANTI-CACHE ==========
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    // Désactiver le cache pour index.html
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'index.html'));
});
initAndStart();