const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const PDFDocument = require('pdfkit');
const http = require('http');
const https = require('https');
const compression = require('compression');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(compression());
app.use(express.static(path.join(__dirname)));

require('dotenv').config();

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gestpro_db',
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 20,
    connectTimeout: 10000,
    acquireTimeout: 10000,
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

        // ----- CRÉATION DES TABLES -----
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('admin','user') DEFAULT 'user',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

       // Dans initAndStart(), remplacez la création de la table settings par :
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
    tax_rate DECIMAL(5,2) DEFAULT 0.00,  -- ✅ Changé de 20.00 à 0.00
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
            wholesale_price DECIMAL(10,2) DEFAULT 0,
            wholesale_quantity INT DEFAULT 0,
            location VARCHAR(100),
            image_url TEXT,
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
    remise_pct DECIMAL(5,2) DEFAULT 0,
    acompte DECIMAL(10,2) DEFAULT 0,
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
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
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
            remise_pct DECIMAL(5,2) DEFAULT 0,
            acompte DECIMAL(10,2) DEFAULT 0,
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
// Dans initAndStart(), après la création des tables existantes, ajoutez :

// ===== TABLE DES PERMISSIONS =====
await pool.query(`CREATE TABLE IF NOT EXISTS permissions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// ===== TABLE DES SOUS-COMPTES =====
await pool.query(`CREATE TABLE IF NOT EXISTS sub_users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    parent_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(email)
)`);

// ===== TABLE DES PERMISSIONS DES SOUS-COMPTES =====
await pool.query(`CREATE TABLE IF NOT EXISTS sub_user_permissions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sub_user_id INT NOT NULL,
    permission_id INT NOT NULL,
    FOREIGN KEY (sub_user_id) REFERENCES sub_users(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
    UNIQUE(sub_user_id, permission_id)
)`);

// ===== TABLE D'AUDIT DES SOUS-COMPTES =====
await pool.query(`CREATE TABLE IF NOT EXISTS sub_user_audit (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sub_user_id INT NOT NULL,
    action VARCHAR(50) NOT NULL,
    details JSON,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sub_user_id) REFERENCES sub_users(id) ON DELETE CASCADE
)`);
// ===== INSERTION DES PERMISSIONS (CORRIGÉ AVEC DOUBLE APOSTROPHE) =====
try {
    await pool.query(`INSERT IGNORE INTO permissions (name, description) VALUES 
        ('dashboard', 'Tableau de bord'),
        ('products_view', 'Voir les produits'),
        ('products_create', 'Créer des produits'),
        ('products_edit', 'Modifier des produits'),
        ('products_delete', 'Supprimer des produits'),
        ('sales_view', 'Voir les ventes'),
        ('sales_create', 'Créer des ventes'),
        ('sales_edit', 'Modifier des ventes'),
        ('sales_delete', 'Supprimer des ventes'),
        ('clients_view', 'Voir les clients'),
        ('clients_create', 'Créer des clients'),
        ('clients_edit', 'Modifier des clients'),
        ('clients_delete', 'Supprimer des clients'),
        ('invoices_view', 'Voir les factures'),
        ('invoices_create', 'Créer des factures'),
        ('invoices_pay', 'Payer les factures'),
        ('cash_view', 'Voir la caisse'),
        ('cash_manage', 'Gérer la caisse'),
        ('inventory_view', 'Voir l\\\'inventaire'),
        ('inventory_manage', 'Gérer l\\\'inventaire'),
        ('reports_view', 'Voir les rapports'),
        ('settings_view', 'Voir les paramètres'),
        ('settings_edit', 'Modifier les paramètres'),
        ('sub_users_manage', 'Gérer l\\\'équipe')
    `);
    // ===== AJOUT AUTOMATIQUE DES COLONNES MANQUANTES =====
try { await pool.query(`ALTER TABLE sales ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
try { await pool.query(`ALTER TABLE proforma_invoices ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
    // Dans initAndStart(), après la création des tables, ajoutez :
// Dans initAndStart(), après la création des tables :
try { await pool.query(`ALTER TABLE sales ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
// ===== VÉRIFICATION ET AJOUT DES COLONNES MANQUANTES =====
console.log('🔍 Vérification des colonnes de la table sales...');

const columnsToAdd = [
    { name: 'status', query: "ALTER TABLE sales ADD COLUMN status ENUM('completed','pending','cancelled') DEFAULT 'completed'" },
    { name: 'remise_pct', query: "ALTER TABLE sales ADD COLUMN remise_pct DECIMAL(5,2) DEFAULT 0" },
    { name: 'acompte', query: "ALTER TABLE sales ADD COLUMN acompte DECIMAL(10,2) DEFAULT 0" },
    { name: 'tax', query: "ALTER TABLE sales ADD COLUMN tax DECIMAL(10,2) DEFAULT 0" },
    { name: 'payment_method', query: "ALTER TABLE sales ADD COLUMN payment_method ENUM('cash','card','transfer') DEFAULT 'cash'" },
    { name: 'due_date', query: "ALTER TABLE sales ADD COLUMN due_date DATE NULL" },
    { name: 'notes', query: "ALTER TABLE sales ADD COLUMN notes TEXT" }
];

for (const col of columnsToAdd) {
    try {
        const [rows] = await pool.query(`SHOW COLUMNS FROM sales LIKE '${col.name}'`);
        if (rows.length === 0) {
            await pool.query(col.query);
            console.log(`✅ Colonne ${col.name} ajoutée`);
        }
    } catch(e) {
        console.log(`⚠️ Erreur pour ${col.name}:`, e.message);
    }
}

// Mettre à jour les statuts existants
try {
    await pool.query(`UPDATE sales SET status = 'completed' WHERE status IS NULL`);
    console.log('✅ Statuts des ventes mis à jour');
} catch(e) {
    console.log('⚠️ Erreur mise à jour statuts:', e.message);
}
    console.log('✅ Permissions insérées avec succès');
} catch (err) {
    console.error('❌ Erreur insertion permissions:', err.message);
}
        // Ajout des colonnes manquantes
        try { await pool.query(`ALTER TABLE sales ADD COLUMN remise_pct DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE sales ADD COLUMN acompte DECIMAL(10,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE proforma_invoices ADD COLUMN remise_pct DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE proforma_invoices ADD COLUMN acompte DECIMAL(10,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE settings ADD COLUMN company_subtitle VARCHAR(200)`); } catch(e) {}
        try { await pool.query(`ALTER TABLE settings ADD COLUMN company_activity TEXT`); } catch(e) {}
        try { await pool.query(`ALTER TABLE settings ADD COLUMN company_rc VARCHAR(100)`); } catch(e) {}
        try { await pool.query(`ALTER TABLE settings ADD COLUMN company_phone2 VARCHAR(50)`); } catch(e) {}
        try { await pool.query(`ALTER TABLE products ADD COLUMN image_url TEXT`); } catch(e) {}
        try { await pool.query(`ALTER TABLE products ADD COLUMN wholesale_price DECIMAL(10,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE products ADD COLUMN wholesale_quantity INT DEFAULT 0`); } catch(e) {}

        // ✅ AJOUT DES INDEX
        try { await pool.query(`CREATE INDEX idx_sales_user_id ON sales(user_id)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_sales_sale_date ON sales(sale_date)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_sales_status ON sales(status)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_products_user_id ON products(user_id)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_products_name ON products(name)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id)`); } catch(e) {}

        console.log('✅ Tables prêtes avec index');
        
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
// ===== FORMATAGE DES NOMBRES AVEC POINTS (POUR PDF) =====
function formatPDFNumber(number) {
    if (number === undefined || number === null || isNaN(number)) return '0';
    
    // Arrondir à l'entier (pas de décimales)
    const rounded = Math.round(number);
    
    // Convertir en chaîne et séparer les milliers avec des points
    const str = rounded.toString();
    let result = '';
    let count = 0;
    
    // Parcourir la chaîne de droite à gauche
    for (let i = str.length - 1; i >= 0; i--) {
        result = str[i] + result;
        count++;
        // Ajouter un point tous les 3 caractères sauf à la fin
        if (count % 3 === 0 && i !== 0) {
            result = '.' + result;
        }
    }
    
    return result;
}

// ===== DÉSACTIVER LE CACHE POUR TOUTES LES RÉPONSES API =====
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
// ========== ROUTES AUTH ==========
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6)
        return res.status(400).json({ error: 'Champs invalides (mot de passe min 6)' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        const [result] = await pool.query('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email, hashed]);
        await pool.query(`INSERT INTO settings (user_id, company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [result.insertId, 'Mon Entreprise', '', '', '', '', '', '', '', '', 20, 5, 'FCFA']);
        res.status(201).json({ message: 'Utilisateur créé' });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ========== ROUTES CLIENTS ==========
app.get('/api/clients', authenticate, async (req, res) => {
    const { search } = req.query;
    let query = 'SELECT * FROM clients WHERE user_id=?';
    const params = [req.user.id];
    if (search) { query += ' AND name LIKE ?'; params.push(`%${search}%`); }
    query += ' ORDER BY name LIMIT 100';
    const [rows] = await pool.query(query, params);
    res.json(rows);
});

app.post('/api/clients', authenticate, async (req, res) => {
    const { name, email, phone, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    const [result] = await pool.query('INSERT INTO clients (user_id, name, email, phone, address) VALUES (?,?,?,?,?)', [req.user.id, name, email, phone, address]);
    res.status(201).json({ id: result.insertId, name, email, phone, address });
});

app.put('/api/clients/:id', authenticate, async (req, res) => {
    const { name, email, phone, address } = req.body;
    await pool.query('UPDATE clients SET name=?, email=?, phone=?, address=? WHERE id=? AND user_id=?', [name, email, phone, address, req.params.id, req.user.id]);
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
    } catch(err) { res.status(400).json({ error: 'Catégorie existe déjà' }); }
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

// ========== ROUTES PRODUITS (SANS LIMITE) ==========
app.get('/api/products', authenticate, async (req, res) => {
    // ✅ Supprimer LIMIT 500 pour voir tous les produits
    const [rows] = await pool.query(
        'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.user_id = ? ORDER BY p.name',
        [req.user.id]
    );
    res.json(rows);
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
    query += ' ORDER BY p.name'; // ✅ Supprimer LIMIT 200
    const [rows] = await pool.query(query, params);
    res.json(rows);
});
app.post('/api/products', authenticate, async (req, res) => {
    const { sku, barcode, name, description, category_id, category_name, supplier_id, quantity, unit, reorder_level, buy_price, sell_price, wholesale_price, wholesale_quantity, location, image_url } = req.body;
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
            INSERT INTO products (user_id, sku, barcode, name, description, category_id, supplier_id, quantity, unit, reorder_level, buy_price, sell_price, wholesale_price, wholesale_quantity, location, image_url)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [req.user.id, sku, barcode || null, name, description || '', finalCatId || null, supId, quantity || 0, unit || 'pièce', reorder_level || 5, buy_price || 0, sell_price || 0, wholesale_price || 0, wholesale_quantity || 0, location || null, image_url || null]
        );
        await connection.commit();
        res.status(201).json({ id: result.insertId });
    } catch (err) {
        await connection.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'SKU ou code barre déjà utilisé' });
        res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    } finally {
        connection.release();
    }
});
// ===== ROUTE MODIFICATION PRODUIT (CORRIGÉE DÉFINITIVEMENT) =====
app.put('/api/products/:id', authenticate, async (req, res) => {
    const productId = parseInt(req.params.id);
    const userId = req.user.id;
    
    console.log(`🔍 Modification produit ID: ${productId} par utilisateur ${userId}`);
    
    // ✅ 1. Vérifier que le produit existe et appartient à l'utilisateur
    const [existing] = await pool.query(
        'SELECT id, name, user_id FROM products WHERE id = ? AND user_id = ?',
        [productId, userId]
    );
    
    if (existing.length === 0) {
        console.log(`❌ Produit ${productId} non trouvé pour l'utilisateur ${userId}`);
        return res.status(404).json({ 
            error: 'Produit non trouvé',
            details: `ID: ${productId}, User: ${userId}`
        });
    }
    
    console.log(`✅ Produit trouvé: ${existing[0].name} (ID: ${productId})`);
    
    // Récupérer les données du corps
    const { 
        sku, barcode, name, description, category_id, category_name, 
        supplier_id, quantity, unit, reorder_level, buy_price, 
        sell_price, wholesale_price, wholesale_quantity, location, image_url 
    } = req.body;
    
    // ✅ 2. Gérer la catégorie
    let finalCatId = category_id;
    if (category_name && category_name.trim() !== '') {
        let [cat] = await pool.query(
            'SELECT id FROM categories WHERE user_id=? AND name=?',
            [userId, category_name]
        );
        if (cat.length === 0) {
            const [catResult] = await pool.query(
                'INSERT INTO categories (user_id, name) VALUES (?,?)',
                [userId, category_name]
            );
            finalCatId = catResult.insertId;
        } else {
            finalCatId = cat[0].id;
        }
    }
    
    const supId = supplier_id ? parseInt(supplier_id) : null;
    
    try {
        // ✅ 3. Mettre à jour
        await pool.query(`
            UPDATE products SET 
                sku=?, barcode=?, name=?, description=?, category_id=?, 
                supplier_id=?, quantity=?, unit=?, reorder_level=?, 
                buy_price=?, sell_price=?, wholesale_price=?, wholesale_quantity=?, 
                location=?, image_url=?
            WHERE id=? AND user_id=?
        `, [
            sku, barcode || null, name, description || '', finalCatId || null,
            supId, quantity || 0, unit || 'pièce', reorder_level || 5,
            buy_price || 0, sell_price || 0, wholesale_price || 0, wholesale_quantity || 0,
            location || null, image_url || null,
            productId, userId
        ]);
        
        console.log(`✅ Produit ${productId} mis à jour avec succès`);
        res.json({ message: 'Mis à jour' });
    } catch (err) {
        console.error('❌ Erreur mise à jour:', err);
        res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    }
});

// ===== ROUTE DELETE PRODUITS (CORRIGÉE) =====
app.delete('/api/products/:id', authenticate, async (req, res) => {
    const productId = parseInt(req.params.id);
    const userId = req.user.id;
    
    const [existing] = await pool.query(
        'SELECT id FROM products WHERE id = ? AND user_id = ?',
        [productId, userId]
    );
    
    if (existing.length === 0) {
        return res.status(404).json({ error: 'Produit non trouvé' });
    }
    
    await pool.query('DELETE FROM products WHERE id = ? AND user_id = ?', [productId, userId]);
    res.json({ message: 'Produit supprimé' });
});


app.get('/api/products/barcode/:code', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM products WHERE user_id=? AND barcode=?', [req.user.id, req.params.code]);
    if (rows.length === 0) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json(rows[0]);
});

// ========== ROUTES VENTES ==========
app.post('/api/sales', authenticate, async (req, res) => {
    console.log('📦 Données reçues:', req.body);
    
    const { 
        client_name = '', 
        client_email = '', 
        client_phone = '', 
        client_address = '', 
        items = [], 
        remise_pct = 0, 
        acompte = 0, 
        payment_method = 'cash', 
        status = 'completed', 
        due_date = null,
        is_wholesale = false
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Aucun produit dans le panier' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let client_id = null;
        if (client_name && client_name.trim() !== '') {
            let [existing] = await connection.query(
                'SELECT id FROM clients WHERE user_id=? AND name=?', 
                [req.user.id, client_name]
            );
            if (existing.length > 0) {
                client_id = existing[0].id;
            } else {
                const [result] = await connection.query(
                    'INSERT INTO clients (user_id, name, email, phone, address) VALUES (?, ?, ?, ?, ?)',
                    [req.user.id, client_name, client_email || null, client_phone || null, client_address || null]
                );
                client_id = result.insertId;
            }
        }

        let subtotal = 0;
        for (let item of items) {
            if (!item.product_id || !item.quantity || !item.unit_price) {
                throw new Error(`Produit ${item.product_id} invalide`);
            }
            const [prod] = await connection.query(
                'SELECT quantity FROM products WHERE id=? AND user_id=? FOR UPDATE', 
                [item.product_id, req.user.id]
            );
            if (prod.length === 0) {
                throw new Error(`Produit ${item.product_id} inexistant`);
            }
            if (prod[0].quantity < item.quantity) {
                throw new Error(`Stock insuffisant pour le produit ${item.product_id}`);
            }
            item.total_price = item.unit_price * item.quantity;
            subtotal += item.total_price;
        }

        // ✅ Récupération du taux de TVA
        const [settings] = await connection.query(
            'SELECT tax_rate FROM settings WHERE user_id = ?', 
            [req.user.id]
        );
        const tax_rate = settings[0]?.tax_rate !== null && settings[0]?.tax_rate !== undefined 
            ? parseFloat(settings[0].tax_rate) 
            : 0;

        // ✅ Déclaration de tax et autres calculs
        const tax = subtotal * (tax_rate / 100);
        const remise_valeur = (remise_pct || 0) / 100 * subtotal;
        const total_apres_remise = subtotal - remise_valeur;
        const final_amount = total_apres_remise + tax - (acompte || 0);

        const finalStatus = status === 'pending' ? 'pending' : 'completed';
        const [saleResult] = await connection.query(`
            INSERT INTO sales 
            (user_id, client_id, total_amount, remise_pct, acompte, tax, final_amount, payment_method, status, due_date, notes, tax_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            req.user.id, client_id, subtotal, remise_pct || 0, acompte || 0, 
            tax, final_amount, payment_method || 'cash', finalStatus, due_date || null,
            is_wholesale ? 'VENTE EN GROS' : null,
            tax_rate   // ✅ Stockage du taux
        ]);
        const sale_id = saleResult.insertId;

        for (let item of items) {
            await connection.query(
                `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price) 
                 VALUES (?, ?, ?, ?, ?)`,
                [sale_id, item.product_id, item.quantity, item.unit_price, item.total_price]
            );

            const [prodBefore] = await connection.query(
                'SELECT quantity FROM products WHERE id=? FOR UPDATE', 
                [item.product_id]
            );
            const oldQty = prodBefore[0].quantity;
            const newQty = oldQty - item.quantity;
            await connection.query(
                'UPDATE products SET quantity=? WHERE id=?', 
                [newQty, item.product_id]
            );
            await connection.query(
                `INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, reference, notes)
                 VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)`,
                [item.product_id, req.user.id, -item.quantity, oldQty, newQty, `VENTE #${sale_id}`, is_wholesale ? 'Vente en gros' : null]
            );
        }

        if (finalStatus === 'completed') {
            await connection.query(
                'INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)',
                [sale_id, final_amount, payment_method || 'cash']
            );
            await connection.query(
                `INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) 
                 VALUES (?, 'sale', ?, ?, ?)`,
                [req.user.id, final_amount, `Vente #${sale_id}`, sale_id]
            );
        }

        await connection.commit();
        res.status(201).json({ 
            sale_id, 
            final_amount, 
            status: finalStatus,
            message: 'Vente enregistrée avec succès'
        });

    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur vente:', err);
        res.status(400).json({ 
            error: err.message,
            details: err.stack 
        });
    } finally {
        connection.release();
    }
});

app.get('/api/sales', authenticate, async (req, res) => {
    const { client_name, status, start_date, end_date, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let query = `SELECT s.*, c.name as client_name FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id = ?`;
    const params = [req.user.id];
    
    if (client_name) { query += ` AND c.name LIKE ?`; params.push(`%${client_name}%`); }
    if (status) { query += ` AND s.status = ?`; params.push(status); }
    if (start_date) { query += ` AND DATE(s.sale_date) >= ?`; params.push(start_date); }
    if (end_date) { query += ` AND DATE(s.sale_date) <= ?`; params.push(end_date); }
    
    query += ` ORDER BY s.sale_date DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);
    
    const [rows] = await pool.query(query, params);
    res.json(rows);
});

app.get('/api/sales/:id', authenticate, async (req, res) => {
    const [saleRows] = await pool.query('SELECT * FROM sales WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
    const [items] = await pool.query('SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?', [req.params.id]);
    const [payments] = await pool.query('SELECT * FROM payments WHERE sale_id = ? ORDER BY payment_date', [req.params.id]);
    res.json({ sale: saleRows[0], items, payments });
});

app.put('/api/sales/:id', authenticate, async (req, res) => {
    const { remise_pct, acompte } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [saleRows] = await connection.query('SELECT * FROM sales WHERE id=? AND user_id=? FOR UPDATE', [req.params.id, req.user.id]);
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];
        const newRemise = remise_pct !== undefined ? remise_pct : sale.remise_pct;
        const newAcompte = acompte !== undefined ? acompte : sale.acompte;
        const remise_valeur = (newRemise || 0) / 100 * sale.total_amount;
        const total_apres_remise = sale.total_amount - remise_valeur;
        const new_final = total_apres_remise + sale.tax - (newAcompte || 0);
        await connection.query('UPDATE sales SET remise_pct=?, acompte=?, final_amount=? WHERE id=?', [newRemise, newAcompte, new_final, req.params.id]);
        if (sale.status === 'completed') {
            const diff = new_final - sale.final_amount;
            if (diff !== 0) {
                await connection.query('UPDATE payments SET amount=? WHERE sale_id=?', [new_final, req.params.id]);
                await connection.query('UPDATE cash_register SET amount=amount+? WHERE reference_id=? AND transaction_type="sale"', [diff, req.params.id]);
            }
        }
        await connection.commit();
        res.json({ message: 'Vente modifiée' });
    } catch(err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// ========== ROUTE PAIEMENT CORRIGÉE ==========
app.post('/api/sales/:id/payment', authenticate, async (req, res) => {
    const { amount, payment_method } = req.body;
    const saleId = req.params.id;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [saleRows] = await connection.query('SELECT * FROM sales WHERE id=? AND user_id=? FOR UPDATE', [saleId, req.user.id]);
        if (saleRows.length === 0) return res.status(404).json({ error: 'Facture non trouvée' });
        const sale = saleRows[0];
        if (sale.status === 'completed') return res.status(400).json({ error: 'Cette facture est déjà réglée' });
        
        const [paidRows] = await connection.query('SELECT COALESCE(SUM(amount),0) as total_paid FROM payments WHERE sale_id=?', [saleId]);
        const totalPaid = parseFloat(paidRows[0].total_paid);
        const remaining = parseFloat(sale.final_amount) - totalPaid;
        const paymentAmount = parseFloat(amount);
        
        if (paymentAmount > remaining) {
            return res.status(400).json({ error: `Le montant dépasse le reste à payer (${formatNumber(remaining)} FCFA)` });
        }
        
        await connection.query('INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)', [saleId, paymentAmount, payment_method || 'cash']);
        await connection.query(`INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) VALUES (?, 'deposit', ?, ?, ?)`, [req.user.id, paymentAmount, `Règlement facture #${saleId}`, saleId]);
        
        const newTotalPaid = totalPaid + paymentAmount;
        let newStatus = sale.status;
        if (newTotalPaid >= parseFloat(sale.final_amount) - 0.01) {
            await connection.query('UPDATE sales SET status = "completed" WHERE id = ?', [saleId]);
            newStatus = 'completed';
        }
        
        await connection.commit();
        res.json({ 
            message: '✅ Règlement enregistré', 
            remaining: parseFloat(sale.final_amount) - newTotalPaid, 
            status: newStatus,
            paid: newTotalPaid
        });
    } catch(err) {
        await connection.rollback();
        console.error('Erreur paiement:', err);
        res.status(500).json({ error: 'Erreur interne lors du règlement: ' + err.message });
    } finally {
        connection.release();
    }
});

// ========== ROUTES CAISSE ==========
app.get('/api/cash-register', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM cash_register WHERE user_id=? ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    res.json(rows);
});

app.post('/api/cash-register', authenticate, async (req, res) => {
    const { transaction_type, amount, description } = req.body;
    if (!transaction_type || !amount) return res.status(400).json({ error: 'Type et montant requis' });
    const allowed = ['sale','purchase','expense','withdrawal','deposit','payment'];
    if (!allowed.includes(transaction_type)) return res.status(400).json({ error: 'Type invalide' });
    await pool.query('INSERT INTO cash_register (user_id, transaction_type, amount, description) VALUES (?,?,?,?)', [req.user.id, transaction_type, amount, description]);
    res.status(201).json({ message: 'Transaction ajoutée' });
});

app.get('/api/cash-register/summary', authenticate, async (req, res) => {
    const [entrees] = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM cash_register WHERE user_id = ? AND transaction_type IN ('sale', 'deposit', 'payment')`, [req.user.id]);
    const [sorties] = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM cash_register WHERE user_id = ? AND transaction_type IN ('purchase','expense','withdrawal')`, [req.user.id]);
    res.json({ entries: entrees[0].total, expenses: sorties[0].total, balance: entrees[0].total - sorties[0].total });
});

// ========== ROUTES INVENTAIRE ==========
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
        await connection.query('INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, notes) VALUES (?, ?, "adjustment", ?, ?, ?, ?)', [product_id, req.user.id, change, oldQty, new_quantity, reason || 'Ajustement manuel']);
        await connection.commit();
        res.json({ message: 'Stock ajusté', oldQty, new_quantity });
    } catch(err) {
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

// ========== ROUTES RAPPORTS ==========
app.get('/api/reports/dashboard', authenticate, async (req, res) => {
    try {
        const [totalProducts] = await pool.query('SELECT COUNT(*) as count FROM products WHERE user_id=?', [req.user.id]);
        const [lowStock] = await pool.query('SELECT COUNT(*) as count FROM products WHERE user_id=? AND quantity <= reorder_level', [req.user.id]);
        const [inventoryValue] = await pool.query('SELECT COALESCE(SUM(quantity * buy_price),0) as value FROM products WHERE user_id=?', [req.user.id]);
        const [todaySales] = await pool.query(`SELECT COALESCE(SUM(final_amount),0) as total FROM sales WHERE user_id=? AND DATE(sale_date) = CURDATE() AND status='completed'`, [req.user.id]);
        const [monthSales] = await pool.query(`SELECT COALESCE(SUM(final_amount),0) as total FROM sales WHERE user_id=? AND MONTH(sale_date)=MONTH(CURDATE()) AND YEAR(sale_date)=YEAR(CURDATE())`, [req.user.id]);
        const [topProducts] = await pool.query('SELECT p.name, SUM(si.quantity) as qte FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id WHERE s.user_id=? AND s.status=\'completed\' GROUP BY p.id ORDER BY qte DESC LIMIT 5', [req.user.id]);
        const [recentSales] = await pool.query('SELECT s.id, s.final_amount, s.sale_date, c.name as client_name FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id=? ORDER BY s.sale_date DESC LIMIT 5', [req.user.id]);

        res.json({
            totalProducts: totalProducts[0].count,
            lowStock: lowStock[0].count,
            inventoryValue: inventoryValue[0].value || 0,
            todaySales: todaySales[0].total,
            monthSales: monthSales[0].total,
            topProducts: topProducts || [],
            recentSales: recentSales || []
        });
    } catch (err) {
        console.error('❌ Erreur dashboard :', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/sales-by-period', authenticate, async (req, res) => {
    const { period } = req.query;
    let groupBy;
    let limit = 30;
    
    switch(period) {
        case 'week':
            groupBy = 'DATE(sale_date)';
            limit = 7;
            break;
        case 'month':
            groupBy = 'DATE(sale_date)';
            limit = 30;
            break;
        default:
            groupBy = 'DATE_FORMAT(sale_date, "%Y-%m")';
            limit = 12;
    }
    
    try {
        const query = `
            SELECT ${groupBy} as date, 
                   COALESCE(SUM(final_amount), 0) as total 
            FROM sales 
            WHERE user_id = ? 
              AND status = 'completed'
            GROUP BY ${groupBy}
            ORDER BY date DESC 
            LIMIT ?
        `;
        const [rows] = await pool.query(query, [req.user.id, limit]);
        res.json(rows.reverse());
    } catch (err) {
        console.error('❌ Erreur sales-by-period:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTES PARAMÈTRES (CORRIGÉ) ==========

// ✅ GET : Récupérer les paramètres
app.get('/api/settings', authenticate, async (req, res) => {
    try {
        let [rows] = await pool.query('SELECT * FROM settings WHERE user_id=?', [req.user.id]);

        if (rows.length === 0) {
            await pool.query(
                `INSERT INTO settings (user_id, company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.user.id, 'Mon Entreprise', '', '', '', '', '', '', '', '', 20, 5, 'FCFA']
            );
            [rows] = await pool.query('SELECT * FROM settings WHERE user_id=?', [req.user.id]);
        }

        const settings = rows[0] || {};
        res.json({
            company_name: settings.company_name || 'Mon Entreprise',
            company_subtitle: settings.company_subtitle || '',
            company_activity: settings.company_activity || '',
            company_rc: settings.company_rc || '',
            company_address: settings.company_address || '',
            company_phone: settings.company_phone || '',
            company_phone2: settings.company_phone2 || '',
            company_email: settings.company_email || '',
            logo_url: settings.logo_url || '',
            tax_rate: settings.tax_rate !== null && settings.tax_rate !== undefined 
                ? parseFloat(settings.tax_rate) 
                : 20,
            low_stock_alert: parseInt(settings.low_stock_alert) || 5,
            currency: settings.currency || 'FCFA'
        });
    } catch (err) {
        console.error('❌ Erreur GET /settings:', err);
        res.status(500).json({ error: 'Erreur lors du chargement des paramètres.' });
    }
});
// ========== ROUTES PARAMÈTRES (CORRIGÉ DÉFINITIF) ==========

// ✅ PUT : Mettre à jour les paramètres - PERMET 0%
app.put('/api/settings', authenticate, async (req, res) => {
    const {
        company_name, company_subtitle, company_activity, company_rc,
        company_address, company_phone, company_phone2, company_email,
        logo_url, tax_rate, low_stock_alert, currency
    } = req.body;

    // ✅ Gestion du taux de TVA - Permet 0
    let taxRateToSave;
    if (tax_rate === undefined || tax_rate === null || tax_rate === '') {
        taxRateToSave = 0; // ✅ Changé de 20 à 0 par défaut
    } else {
        taxRateToSave = parseFloat(tax_rate);
        if (isNaN(taxRateToSave)) {
            return res.status(400).json({ error: 'Le taux de TVA doit être un nombre valide.' });
        }
        // ✅ On conserve 0 si c'est 0
    }

    try {
        await pool.query(
            `UPDATE settings SET 
                company_name = ?, company_subtitle = ?, company_activity = ?, company_rc = ?, 
                company_address = ?, company_phone = ?, company_phone2 = ?, company_email = ?, 
                logo_url = ?, tax_rate = ?, low_stock_alert = ?, currency = ? 
             WHERE user_id = ?`,
            [
                company_name, company_subtitle, company_activity, company_rc,
                company_address, company_phone, company_phone2, company_email,
                logo_url, taxRateToSave,
                parseInt(low_stock_alert) || 5,
                currency || 'FCFA',
                req.user.id
            ]
        );
        console.log(`✅ Taux de TVA mis à jour : ${taxRateToSave}%`);
        res.json({ message: 'Paramètres mis à jour avec succès' });
    } catch (err) {
        console.error('❌ Erreur PUT /settings:', err);
        res.status(500).json({ error: 'Erreur lors de la mise à jour des paramètres.' });
    }
});
// ========== ROUTE HISTORIQUE ==========
app.get('/api/history', authenticate, async (req, res) => {
    const [sales] = await pool.query(`SELECT 'sale' as type, s.id, s.final_amount as amount, s.sale_date as date, c.name as client_name, s.status FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id = ? ORDER BY s.sale_date DESC LIMIT 50`, [req.user.id]);
    const [movements] = await pool.query(`SELECT 'stock' as type, sm.id, sm.quantity_change as amount, sm.created_at as date, p.name as product_name, sm.type as movement_type FROM stock_movements sm JOIN products p ON sm.product_id = p.id WHERE sm.user_id = ? ORDER BY sm.created_at DESC LIMIT 50`, [req.user.id]);
    const history = [...sales, ...movements].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0,50);
    res.json(history);
});
// ========== ROUTES PROFORMA ==========

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
    const { client_name, client_email, client_phone, client_address, items, remise_pct, acompte, valid_until, notes } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'Aucun article' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let subtotal = 0;
        for (let item of items) {
            item.total_price = item.quantity * item.unit_price;
            subtotal += item.total_price;
        }

        // ✅ Récupération du taux de TVA
        const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [req.user.id]);
        const tax_rate = settings[0]?.tax_rate !== null && settings[0]?.tax_rate !== undefined 
            ? parseFloat(settings[0].tax_rate) 
            : 0;

        const tax = subtotal * (tax_rate / 100);
        const remise_valeur = (remise_pct || 0) / 100 * subtotal;
        const total_apres_remise = subtotal - remise_valeur;
        const total = total_apres_remise + tax - (acompte || 0);

        const proformaNumber = await getNextProformaNumber(req.user.id);

        // ✅ INSERT avec guillemets simples pour 'draft' et colonne tax_rate
        const [result] = await connection.query(`
            INSERT INTO proforma_invoices 
            (user_id, proforma_number, client_name, client_email, client_phone, client_address, 
             subtotal, tax, remise_pct, acompte, total, valid_until, notes, status, tax_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            req.user.id, proformaNumber, client_name || '', client_email || '', client_phone || '', client_address || '',
            subtotal, tax, remise_pct || 0, acompte || 0, total, valid_until || null, notes || '',
            'draft',   // ✅ Guillemets SIMPLES
            tax_rate   // ✅ Sauvegarde du taux
        ]);

        const proformaId = result.insertId;

        for (let item of items) {
            await connection.query(
                'INSERT INTO proforma_items (proforma_id, description, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)',
                [proformaId, item.description, item.quantity, item.unit_price, item.total_price]
            );
        }

        await connection.commit();
        res.status(201).json({ id: proformaId, number: proformaNumber });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur proforma:', err);
        res.status(500).json({ error: err.message });
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
// ========== ROUTE PROFORMA PDF ==========
app.get('/api/proforma/:id/pdf', authenticate, async (req, res) => {
    try {
        const proformaId = req.params.id;
        // ✅ Requête corrigée : pas d'alias 's'
        const [invoiceRows] = await pool.query(`
            SELECT * FROM proforma_invoices 
            WHERE id = ? AND user_id = ?
        `, [proformaId, req.user.id]);
        
        if (invoiceRows.length === 0) return res.status(404).json({ error: 'Proforma non trouvée' });
        const invoice = invoiceRows[0];
        
        const [items] = await pool.query('SELECT * FROM proforma_items WHERE proforma_id = ?', [proformaId]);
        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', currency: 'FCFA' };

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=proforma_${invoice.proforma_number}.pdf`);
        doc.pipe(res);

        // En-tête
        let y = await drawCompanyHeader(doc, company);

        // Titre
        doc.fillColor('#2c6e9e').fontSize(20).font('Helvetica-Bold')
           .text(`FACTURE PROFORMA N° ${invoice.proforma_number}`, 50, y, { align: 'center' });
        y += 30;

        // Infos client
        doc.fillColor('#1a2a3a').fontSize(11).font('Helvetica')
           .text(`Date : ${new Date(invoice.issue_date).toLocaleDateString('fr-FR')}`, 50, y);
        y += 16;
        doc.text(`Client : ${invoice.client_name || 'Client particulier'}`, 50, y);
        if (invoice.client_address) { y += 16; doc.text(`Adresse : ${invoice.client_address}`, 50, y); }
        if (invoice.client_email) { y += 16; doc.text(`Email : ${invoice.client_email}`, 50, y); }
        if (invoice.valid_until) { y += 16; doc.text(`Valable jusqu'au : ${new Date(invoice.valid_until).toLocaleDateString('fr-FR')}`, 50, y); }
        y += 25;

        // Tableau
        const col1 = 60, col2 = 250, col3 = 350, col4 = 450;
        const rowHeight = 22;
        doc.rect(50, y, 500, rowHeight).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
        doc.text('DESIGNATION', col1, y + 6);
        doc.text('QTE', col2, y + 6, { width: 60, align: 'right' });
        doc.text('PRIX UNIT.', col3, y + 6, { width: 70, align: 'right' });
        doc.text('MONTANT', col4, y + 6, { width: 80, align: 'right' });
        y += rowHeight;

        let subtotal = 0;
        items.forEach((item, idx) => {
            const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, y, 500, rowHeight).fill(bg);
            doc.fillColor('#1a2a3a').fontSize(9).font('Helvetica');
            doc.text(item.description, col1 + 2, y + 5);
            doc.text(item.quantity.toString(), col2, y + 5, { width: 60, align: 'right' });
            doc.text(`${formatPDFNumber(item.unit_price)} ${company.currency}`, col3, y + 5, { width: 70, align: 'right' });
            doc.text(`${formatPDFNumber(item.total_price)} ${company.currency}`, col4, y + 5, { width: 80, align: 'right' });
            subtotal += parseFloat(item.total_price);
            y += rowHeight;
        });

        // Ligne de séparation
        doc.moveTo(50, y).lineTo(550, y).stroke('#e0e4e8');
        y += 10;

        // ✅ Récupération du taux de TVA depuis l'objet invoice
        const taxRate = invoice.tax_rate || 0;
        const taxAmount = invoice.tax || 0;
        const remiseValue = (invoice.remise_pct || 0) / 100 * subtotal;
        const acompteValue = invoice.acompte || 0;
        const total = invoice.total || 0;

        const totalX = 370;
        const lines = [];
        lines.push({ label: 'Sous-total', value: formatPDFNumber(subtotal) });
        if (taxRate > 0) {
            lines.push({ label: `TVA (${taxRate}%)`, value: formatPDFNumber(taxAmount) });
        }
        if (invoice.remise_pct && invoice.remise_pct > 0) {
            lines.push({ label: `Remise (${invoice.remise_pct}%)`, value: `- ${formatPDFNumber(remiseValue)}` });
        }
        if (acompteValue > 0) {
            lines.push({ label: 'Acompte', value: `- ${formatPDFNumber(acompteValue)}` });
        }

        lines.forEach((line, i) => {
            const yPos = y + i * 22;
            doc.fillColor(i === lines.length - 1 ? '#1a2a3a' : '#3a4a5a');
            doc.fontSize(i === lines.length - 1 ? 11 : 10).font(i === lines.length - 1 ? 'Helvetica-Bold' : 'Helvetica');
            doc.text(line.label, totalX, yPos, { width: 100, align: 'right' });
            doc.text(`${line.value} ${company.currency}`, 450, yPos, { width: 80, align: 'right' });
        });

        const totalY = y + lines.length * 22 + 8;
        doc.rect(350, totalY, 200, 30).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold');
        doc.text('NET À PAYER', 360, totalY + 8);
        doc.text(`${formatPDFNumber(total)} ${company.currency}`, 450, totalY + 8, { width: 80, align: 'right' });

        // Pied
        doc.rect(50, 750, 500, 25).fill('#f0f4f8');
        doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
        doc.text('Document non contractuel - Devis valant accord', 50, 758, { align: 'center' });

        doc.end();
    } catch (err) {
        console.error('Erreur génération proforma:', err);
        res.status(500).json({ error: 'Erreur génération proforma' });
    }
});
// ========== ROUTE EXPORT ==========
app.get('/api/export', authenticate, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT * FROM users');
        const [products] = await pool.query('SELECT * FROM products');
        const [sales] = await pool.query('SELECT * FROM sales');
        const [clients] = await pool.query('SELECT * FROM clients');
        const [categories] = await pool.query('SELECT * FROM categories');
        res.json({ users, products, sales, clients, categories });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== PDF HEADER (FOND BLANC SUR TOUTE LA LARGEUR) ==========
async function drawCompanyHeader(doc, company, startY = 45) {
    // ✅ Fond blanc sur toute la largeur (50 à 550)
    const fullWidth = 500;
    const headerHeight = 110;
    doc.rect(50, startY, fullWidth, headerHeight)
       .fill('#ffffff');
    // ✅ AUCUNE BORDURE (pas de stroke)
    
    // Gestion du logo
    let logoX = 50;
    let textStartX = 50;
    let textWidth = 500;
    
    if (company.logo_url && company.logo_url.trim() !== '') {
        try { 
            const logoBuffer = await fetchImage(company.logo_url); 
            doc.image(logoBuffer, 50, startY + 5, { width: 80 }); 
            textStartX = 150;
            textWidth = 400;
        } catch(e) {}
    }
    
    // ✅ Texte en bleu foncé
    doc.fillColor('#2c3e50');
    doc.fontSize(18).font('Helvetica-Bold')
       .text(company.company_name, textStartX, startY + 10, { 
           width: textWidth - 20, 
           align: 'center' 
       });
    
    let currentY = startY + 35;
    if (company.company_subtitle && company.company_subtitle.trim() !== '') { 
        doc.fontSize(10).font('Helvetica')
           .text(company.company_subtitle, textStartX, currentY, { 
               width: textWidth - 20, 
               align: 'center' 
           }); 
        currentY += 15; 
    }
    if (company.company_activity && company.company_activity.trim() !== '') { 
        doc.fontSize(9).font('Helvetica-Oblique')
           .text(company.company_activity, textStartX, currentY, { 
               width: textWidth - 20, 
               align: 'center' 
           }); 
        currentY += 15; 
    }
    if (company.company_rc && company.company_rc.trim() !== '') { 
        doc.fontSize(8).font('Helvetica')
           .text(company.company_rc, textStartX, currentY, { 
               width: textWidth - 20, 
               align: 'center' 
           }); 
        currentY += 15; 
    }
    if (company.company_address && company.company_address.trim() !== '') { 
        doc.fontSize(9).font('Helvetica')
           .text(company.company_address, textStartX, currentY, { 
               width: textWidth - 20, 
               align: 'center' 
           }); 
        currentY += 15; 
    }
    
    let phoneLine = '';
    if (company.company_phone) phoneLine += `Tél : ${company.company_phone}`;
    if (company.company_phone2) phoneLine += ` // ${company.company_phone2}`;
    if (phoneLine) {
        doc.fontSize(9).font('Helvetica')
           .text(phoneLine, textStartX, currentY, { 
               width: textWidth - 20, 
               align: 'center' 
           });
    }
    
    // ✅ Ligne de séparation horizontale (sans trait vertical)
    doc.moveTo(50, startY + headerHeight + 5)
       .lineTo(550, startY + headerHeight + 5)
       .stroke('#cccccc');
    
    return startY + headerHeight + 20;
}
app.get('/api/sales/:id/invoice', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(`
            SELECT s.*, c.name as client_name, c.email as client_email, c.address as client_address 
            FROM sales s 
            LEFT JOIN clients c ON s.client_id = c.id 
            WHERE s.id = ? AND s.user_id = ?
        `, [saleId, req.user.id]);
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];

        const [items] = await pool.query(`
            SELECT si.*, p.name as product_name 
            FROM sale_items si 
            JOIN products p ON si.product_id = p.id 
            WHERE si.sale_id = ?
        `, [saleId]);

        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', currency: 'FCFA' };

       const taxRate = sale.tax_rate !== null && sale.tax_rate !== undefined 
    ? parseFloat(sale.tax_rate) 
    : parseFloat(company.tax_rate || 0);

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=facture_${saleId}.pdf`);
        doc.pipe(res);

        // En-tête
        let y = await drawCompanyHeader(doc, company);

        // Titre
        doc.fillColor('#2c6e9e').fontSize(20).font('Helvetica-Bold')
           .text(`FACTURE N° ${String(saleId).padStart(5, '0')}`, 50, y, { align: 'center' });
        y += 30;

        // Cadre client / infos facture
        doc.rect(50, y, 500, 70).fill('#f5f7fa').stroke('#e0e4e8', 0.5);
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('CLIENT', 60, y + 8);
        doc.fillColor('#3a4a5a').fontSize(11).font('Helvetica')
           .text(sale.client_name || 'Client particulier', 60, y + 25);
        if (sale.client_address) {
            doc.fontSize(9).font('Helvetica').text(sale.client_address, 60, y + 42);
        }
        if (sale.client_email) {
            doc.fontSize(9).font('Helvetica').text(sale.client_email, 60, y + 58);
        }

        const rightX = 350;
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('DÉTAILS FACTURE', rightX, y + 8);
        doc.fillColor('#3a4a5a').fontSize(10).font('Helvetica')
           .text(`Date : ${new Date(sale.sale_date).toLocaleDateString('fr-FR')}`, rightX, y + 25);

        // Badge statut
        const statusMap = {
            'completed': { label: 'PAYÉE', color: '#27ae60' },
            'pending': { label: 'EN ATTENTE', color: '#f39c12' },
            'cancelled': { label: 'ANNULÉE', color: '#e74c3c' }
        };
        const statusInfo = statusMap[sale.status] || { label: 'INCONNU', color: '#95a5a6' };
        const badgeX = 400, badgeY = y + 42;
        doc.rect(badgeX, badgeY, 90, 20).fill(statusInfo.color);
        doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
           .text(statusInfo.label, badgeX + 18, badgeY + 6);

        y += 85;

        // Tableau des articles
        const col1 = 60, col2 = 250, col3 = 350, col4 = 430, col5 = 490;
        const rowHeight = 22;
        doc.rect(50, y, 500, rowHeight).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
        doc.text('PRODUIT', col1, y + 6);
        doc.text('QTÉ', col2, y + 6, { width: 60, align: 'right' });
        doc.text('PRIX UNIT.', col3, y + 6, { width: 70, align: 'right' });
        doc.text('TOTAL', col5, y + 6, { width: 50, align: 'right' });
        y += rowHeight;

        let subtotal = 0;
        items.forEach((item, idx) => {
            const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, y, 500, rowHeight).fill(bg);
            doc.fillColor('#1a2a3a').fontSize(9).font('Helvetica');
            doc.text(item.product_name || 'Produit', col1 + 2, y + 5);
            doc.text(item.quantity.toString(), col2, y + 5, { width: 60, align: 'right' });
            doc.text(`${formatPDFNumber(item.unit_price)} ${company.currency}`, col3, y + 5, { width: 70, align: 'right' });
            doc.text(`${formatPDFNumber(item.total_price)} ${company.currency}`, col5, y + 5, { width: 50, align: 'right' });
            subtotal += parseFloat(item.total_price);
            y += rowHeight;
        });

        doc.moveTo(50, y).lineTo(550, y).stroke('#e0e4e8');
        y += 10;

        // Totaux
        const totalX = 380;
        const taxAmount = sale.tax || 0;
        const remiseValue = (sale.remise_pct || 0) / 100 * subtotal;
        const acompteValue = sale.acompte || 0;
        const finalAmount = sale.final_amount || 0;

     const lines = [
    { label: 'Sous-total', value: formatPDFNumber(sale.total_amount) }
];
if (taxRate > 0) {
    lines.push({ label: `TVA (${taxRate}%)`, value: formatPDFNumber(sale.tax) });
}
        if (sale.remise_pct && sale.remise_pct > 0) {
            lines.push({ label: `Remise (${sale.remise_pct}%)`, value: `- ${formatPDFNumber(remiseValue)}` });
        }
        if (acompteValue > 0) {
            lines.push({ label: 'Acompte', value: `- ${formatPDFNumber(acompteValue)}` });
        }

        lines.forEach((line, i) => {
            const isTotal = i === lines.length - 1;
            const yPos = y + i * 22;
            doc.fillColor(isTotal ? '#1a2a3a' : '#3a4a5a');
            doc.fontSize(isTotal ? 11 : 10).font(isTotal ? 'Helvetica-Bold' : 'Helvetica');
            doc.text(line.label, totalX, yPos, { width: 100, align: 'right' });
            doc.text(`${line.value} ${company.currency}`, 460, yPos, { width: 80, align: 'right' });
        });

        const totalY = y + lines.length * 22 + 8;
        doc.rect(350, totalY, 200, 30).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold');
        doc.text('NET À PAYER', 360, totalY + 8);
        doc.text(`${formatPDFNumber(finalAmount)} ${company.currency}`, 460, totalY + 8, { width: 80, align: 'right' });

        // Pied
        doc.rect(50, 750, 500, 25).fill('#f0f4f8');
        doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
        doc.text('Merci de votre confiance • Facture générée par GestPro', 50, 758, { align: 'center' });

        doc.end();
    } catch (err) {
        console.error('Erreur génération facture:', err);
        res.status(500).json({ error: 'Erreur génération facture' });
    }
});
// ========== ROUTE BON DE COMMANDE ==========
app.get('/api/sales/:id/order', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(`SELECT s.*, c.name as client_name FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.id = ? AND s.user_id = ?`, [saleId, req.user.id]);
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];
        const [items] = await pool.query(`SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`, [saleId]);
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
        rowY += 15;
        doc.text(`TVA (${company.tax_rate || 20}%) : ${sale.tax.toLocaleString()} ${company.currency}`, 350, rowY);
        rowY += 15;
        if (sale.remise_pct && sale.remise_pct > 0) {
            const remise_valeur = (sale.remise_pct / 100) * sale.total_amount;
            doc.text(`Remise (${sale.remise_pct}%) : ${remise_valeur.toLocaleString()} ${company.currency}`, 350, rowY);
            rowY += 15;
        }
        if (sale.acompte && sale.acompte > 0) {
            doc.text(`Acompte versé : ${sale.acompte.toLocaleString()} ${company.currency}`, 350, rowY);
            rowY += 15;
        }
        doc.fillColor('#3498db').fontSize(12).text(`Net à payer : ${sale.final_amount.toLocaleString()} ${company.currency}`, 350, rowY, { bold: true });
        doc.fillColor('#2c3e50').rect(50, 750, 500, 30).fill();
        doc.fillColor('white').fontSize(8).text('Merci de votre commande', 50, 760, { align: 'center' });
        doc.end();
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur génération bon de commande' });
    }
});

// ========== ROUTE BORDEREAU DE LIVRAISON ==========
app.get('/api/sales/:id/delivery', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(`SELECT s.*, c.name as client_name FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.id = ? AND s.user_id = ?`, [saleId, req.user.id]);
        if (saleRows.length === 0) return res.status(404).json({ error: 'Vente non trouvée' });
        const sale = saleRows[0];
        const [items] = await pool.query(`SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`, [saleId]);
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
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur génération bordereau de livraison' });
    }
});
// ========== ROUTES SOUS-COMPTES ==========

// ✅ GET : Récupérer tous les sous-comptes d'un parent
app.get('/api/sub-users', authenticate, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, name, email, is_active, created_at 
             FROM sub_users 
             WHERE parent_id = ? 
             ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        console.error('❌ Erreur GET /sub-users:', err);
        res.status(500).json({ error: 'Erreur lors du chargement des sous-comptes' });
    }
});

// ✅ GET : Récupérer les permissions d'un sous-compte
app.get('/api/sub-users/:id/permissions', authenticate, async (req, res) => {
    try {
        // Vérifier que le sous-compte appartient bien au parent
        const [check] = await pool.query(
            'SELECT id FROM sub_users WHERE id = ? AND parent_id = ?',
            [req.params.id, req.user.id]
        );
        if (check.length === 0) {
            return res.status(403).json({ error: 'Accès non autorisé' });
        }

        const [rows] = await pool.query(
            `SELECT p.id, p.name, p.description, 
                    CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END as has_permission
             FROM permissions p
             LEFT JOIN sub_user_permissions sp ON p.id = sp.permission_id AND sp.sub_user_id = ?
             ORDER BY p.name`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) {
        console.error('❌ Erreur GET /sub-users/permissions:', err);
        res.status(500).json({ error: 'Erreur lors du chargement des permissions' });
    }
});

// ✅ POST : Créer un sous-compte
app.post('/api/sub-users', authenticate, async (req, res) => {
    const { name, email, password, permissions = [] } = req.body;
    
    if (!name || !email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Tous les champs sont requis (mot de passe min 6)' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Vérifier si l'email existe déjà
        const [existing] = await connection.query(
            'SELECT id FROM users WHERE email = ? UNION SELECT id FROM sub_users WHERE email = ?',
            [email, email]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Cet email est déjà utilisé' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const [result] = await connection.query(
            `INSERT INTO sub_users (parent_id, name, email, password_hash) 
             VALUES (?, ?, ?, ?)`,
            [req.user.id, name, email, hashedPassword]
        );
        
        const subUserId = result.insertId;

        // Ajouter les permissions
        if (permissions.length > 0) {
            const values = permissions.map(p => [subUserId, p]);
            await connection.query(
                'INSERT INTO sub_user_permissions (sub_user_id, permission_id) VALUES ?',
                [values]
            );
        }

        // Journal d'audit
        await connection.query(
            `INSERT INTO sub_user_audit (sub_user_id, action, details) 
             VALUES (?, 'created', ?)`,
            [subUserId, JSON.stringify({ name, email, permissions })]
        );

        await connection.commit();
        res.status(201).json({ 
            id: subUserId, 
            message: 'Sous-compte créé avec succès' 
        });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur POST /sub-users:', err);
        res.status(500).json({ error: 'Erreur lors de la création du sous-compte' });
    } finally {
        connection.release();
    }
});

// ✅ PUT : Mettre à jour un sous-compte
app.put('/api/sub-users/:id', authenticate, async (req, res) => {
    const { name, email, is_active, permissions = [] } = req.body;
    const subUserId = req.params.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Vérifier que le sous-compte appartient au parent
        const [check] = await connection.query(
            'SELECT id FROM sub_users WHERE id = ? AND parent_id = ?',
            [subUserId, req.user.id]
        );
        if (check.length === 0) {
            return res.status(403).json({ error: 'Accès non autorisé' });
        }

        // Mettre à jour les infos
        await connection.query(
            `UPDATE sub_users SET name = ?, email = ?, is_active = ? 
             WHERE id = ? AND parent_id = ?`,
            [name, email, is_active === undefined ? true : is_active, subUserId, req.user.id]
        );

        // Mettre à jour les permissions
        await connection.query(
            'DELETE FROM sub_user_permissions WHERE sub_user_id = ?',
            [subUserId]
        );
        
        if (permissions.length > 0) {
            const values = permissions.map(p => [subUserId, p]);
            await connection.query(
                'INSERT INTO sub_user_permissions (sub_user_id, permission_id) VALUES ?',
                [values]
            );
        }

        // Journal d'audit
        await connection.query(
            `INSERT INTO sub_user_audit (sub_user_id, action, details) 
             VALUES (?, 'updated', ?)`,
            [subUserId, JSON.stringify({ name, email, is_active, permissions })]
        );

        await connection.commit();
        res.json({ message: 'Sous-compte mis à jour avec succès' });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur PUT /sub-users:', err);
        res.status(500).json({ error: 'Erreur lors de la mise à jour du sous-compte' });
    } finally {
        connection.release();
    }
});

// ✅ DELETE : Supprimer un sous-compte
app.delete('/api/sub-users/:id', authenticate, async (req, res) => {
    const subUserId = req.params.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [check] = await connection.query(
            'SELECT id, name, email FROM sub_users WHERE id = ? AND parent_id = ?',
            [subUserId, req.user.id]
        );
        if (check.length === 0) {
            return res.status(403).json({ error: 'Accès non autorisé' });
        }

        // Journal d'audit avant suppression
        await connection.query(
            `INSERT INTO sub_user_audit (sub_user_id, action, details) 
             VALUES (?, 'deleted', ?)`,
            [subUserId, JSON.stringify(check[0])]
        );

        await connection.query(
            'DELETE FROM sub_users WHERE id = ? AND parent_id = ?',
            [subUserId, req.user.id]
        );

        await connection.commit();
        res.json({ message: 'Sous-compte supprimé avec succès' });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur DELETE /sub-users:', err);
        res.status(500).json({ error: 'Erreur lors de la suppression du sous-compte' });
    } finally {
        connection.release();
    }
});

// ✅ POST : Login pour sous-compte
app.post('/api/sub-login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.query(
            `SELECT su.*, u.id as parent_user_id, u.name as parent_name 
             FROM sub_users su 
             JOIN users u ON su.parent_id = u.id 
             WHERE su.email = ? AND su.is_active = 1`,
            [email]
        );
        
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Identifiants invalides ou compte désactivé' });
        }
        
        const subUser = rows[0];
        const valid = await bcrypt.compare(password, subUser.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Identifiants invalides' });
        }

        // Récupérer les permissions
        const [permissions] = await pool.query(
            `SELECT p.name 
             FROM sub_user_permissions sp 
             JOIN permissions p ON sp.permission_id = p.id 
             WHERE sp.sub_user_id = ?`,
            [subUser.id]
        );

        // Journal d'audit
        await pool.query(
            `INSERT INTO sub_user_audit (sub_user_id, action, details, ip_address) 
             VALUES (?, 'login', ?, ?)`,
            [subUser.id, JSON.stringify({ login: true }), req.ip]
        );

        const token = jwt.sign({ 
            userId: subUser.parent_user_id, 
            subUserId: subUser.id,
            isSubUser: true,
            email: subUser.email,
            permissions: permissions.map(p => p.name)
        }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            token, 
            user: {
                id: subUser.id,
                name: subUser.name,
                email: subUser.email,
                role: 'sub_user',
                parent_name: subUser.parent_name,
                permissions: permissions.map(p => p.name)
            }
        });
    } catch (err) {
        console.error('❌ Erreur sub-login:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ✅ GET : Récupérer les permissions disponibles
app.get('/api/permissions', authenticate, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, description FROM permissions ORDER BY name'
        );
        res.json(rows);
    } catch (err) {
        console.error('❌ Erreur GET /permissions:', err);
        res.status(500).json({ error: 'Erreur lors du chargement des permissions' });
    }
});
// ========== MIDDLEWARE DE VÉRIFICATION DES PERMISSIONS ==========
const checkPermission = (permissionName) => {
    return async (req, res, next) => {
        try {
            // Si c'est un admin (parent), on autorise tout
            if (req.user && req.user.role === 'admin') {
                return next();
            }

            // Si c'est un sous-utilisateur
            const subUserId = req.user?.subUserId;
            if (!subUserId) {
                return res.status(403).json({ error: 'Accès non autorisé' });
            }

            const [rows] = await pool.query(
                `SELECT 1 FROM sub_user_permissions sp 
                 JOIN permissions p ON sp.permission_id = p.id 
                 WHERE sp.sub_user_id = ? AND p.name = ?`,
                [subUserId, permissionName]
            );

            if (rows.length === 0) {
                return res.status(403).json({ error: `Permission manquante: ${permissionName}` });
            }

            next();
        } catch (err) {
            console.error('❌ Erreur checkPermission:', err);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    };
};
// ========== ROUTE FICHE CLIENT DÉTAILLÉE ==========
app.get('/api/clients/:id/details', authenticate, async (req, res) => {
    const clientId = req.params.id;
    
    try {
        // 1. Informations du client
        const [client] = await pool.query(
            'SELECT * FROM clients WHERE id = ? AND user_id = ?',
            [clientId, req.user.id]
        );
        if (client.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }
        
        // 2. Historique des ventes
        const [sales] = await pool.query(
            `SELECT s.*, 
                    (SELECT COUNT(*) FROM payments WHERE sale_id = s.id) as payment_count,
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE sale_id = s.id) as total_paid
             FROM sales s 
             WHERE s.client_id = ? AND s.user_id = ?
             ORDER BY s.sale_date DESC LIMIT 50`,
            [clientId, req.user.id]
        );
        
        // 3. Statistiques
        const [stats] = await pool.query(
            `SELECT 
                COUNT(*) as total_orders,
                COALESCE(SUM(final_amount), 0) as total_spent,
                COALESCE(AVG(final_amount), 0) as avg_order,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN final_amount - acompte END), 0) as total_debt,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders
             FROM sales 
             WHERE client_id = ? AND user_id = ?`,
            [clientId, req.user.id]
        );
        
        // 4. Dernière commande
        const [lastOrder] = await pool.query(
            `SELECT * FROM sales 
             WHERE client_id = ? AND user_id = ? 
             ORDER BY sale_date DESC LIMIT 1`,
            [clientId, req.user.id]
        );
        
        res.json({
            client: client[0],
            stats: stats[0],
            sales: sales,
            lastOrder: lastOrder[0] || null
        });
    } catch (err) {
        console.error('❌ Erreur client details:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTE AJOUTER UN CRÉDIT CLIENT ==========
app.post('/api/clients/:id/credit', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { amount, description } = req.body;
    
    try {
        await pool.query(
            `INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) 
             VALUES (?, 'deposit', ?, ?, ?)`,
            [req.user.id, amount, description || `Crédit client #${clientId}`, clientId]
        );
        res.json({ message: 'Crédit ajouté avec succès' });
    } catch (err) {
        console.error('❌ Erreur ajout crédit:', err);
        res.status(500).json({ error: err.message });
    }
});
// ========== ROUTES OPÉRATIONS CLIENT ==========

// ✅ GET : Récupérer le solde et les opérations d'un client
app.get('/api/clients/:id/operations', authenticate, async (req, res) => {
    const clientId = req.params.id;
    
    try {
        // Vérifier que le client appartient à l'utilisateur
        const [clientCheck] = await pool.query(
            'SELECT id FROM clients WHERE id = ? AND user_id = ?',
            [clientId, req.user.id]
        );
        if (clientCheck.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        // Récupérer les opérations
        const [operations] = await pool.query(
            `SELECT * FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')
             ORDER BY created_at DESC`,
            [req.user.id, clientId]
        );

        // Calculer le solde
        const [balance] = await pool.query(
            `SELECT 
                COALESCE(SUM(CASE WHEN transaction_type = 'deposit' OR transaction_type = 'payment' THEN amount ELSE -amount END), 0) as balance
             FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')`,
            [req.user.id, clientId]
        );

        // Dette du client (factures impayées)
        const [debt] = await pool.query(
            `SELECT COALESCE(SUM(final_amount), 0) as total_debt 
             FROM sales 
             WHERE client_id = ? AND status = 'pending'`,
            [clientId]
        );

        res.json({
            operations: operations,
            balance: balance[0].balance || 0,
            debt: debt[0].total_debt || 0
        });
    } catch (err) {
        console.error('❌ Erreur GET /clients/:id/operations:', err);
        res.status(500).json({ error: err.message });
    }
});

// ✅ POST : Ajouter un dépôt client
app.post('/api/clients/:id/deposit', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { amount, description, payment_method = 'cash' } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Montant invalide' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Vérifier que le client existe
        const [client] = await connection.query(
            'SELECT id, name FROM clients WHERE id = ? AND user_id = ?',
            [clientId, req.user.id]
        );
        if (client.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        // Ajouter l'opération dans cash_register
        await connection.query(
            `INSERT INTO cash_register 
             (user_id, transaction_type, amount, description, reference_id) 
             VALUES (?, 'deposit', ?, ?, ?)`,
            [req.user.id, amount, description || `Dépôt de ${client[0].name}`, clientId]
        );

        await connection.commit();
        res.status(201).json({ 
            message: '✅ Dépôt enregistré',
            client: client[0].name,
            amount: amount
        });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur POST /clients/:id/deposit:', err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// ✅ POST : Retrait client (débit)
app.post('/api/clients/:id/withdrawal', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Montant invalide' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Vérifier que le client existe
        const [client] = await connection.query(
            'SELECT id, name FROM clients WHERE id = ? AND user_id = ?',
            [clientId, req.user.id]
        );
        if (client.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        // Vérifier le solde
        const [balance] = await connection.query(
            `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'deposit' OR transaction_type = 'payment' THEN amount ELSE -amount END), 0) as balance
             FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')`,
            [req.user.id, clientId]
        );

        if (balance[0].balance < amount) {
            return res.status(400).json({ 
                error: `Solde insuffisant (${formatNumber(balance[0].balance)} FCFA disponible)` 
            });
        }

        // Ajouter le retrait
        await connection.query(
            `INSERT INTO cash_register 
             (user_id, transaction_type, amount, description, reference_id) 
             VALUES (?, 'withdrawal', ?, ?, ?)`,
            [req.user.id, amount, description || `Retrait de ${client[0].name}`, clientId]
        );

        await connection.commit();
        res.status(201).json({ 
            message: '✅ Retrait enregistré',
            client: client[0].name,
            amount: amount,
            new_balance: balance[0].balance - amount
        });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur POST /clients/:id/withdrawal:', err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// ✅ POST : Payer une facture avec le compte client
app.post('/api/clients/:id/pay-invoice', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { sale_id } = req.body;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Vérifier la vente
        const [sale] = await connection.query(
            'SELECT * FROM sales WHERE id = ? AND client_id = ? AND status = "pending"',
            [sale_id, clientId]
        );
        if (sale.length === 0) {
            return res.status(404).json({ error: 'Facture non trouvée ou déjà payée' });
        }

        const amount = sale[0].final_amount;

        // Vérifier le solde client
        const [balance] = await connection.query(
            `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'deposit' OR transaction_type = 'payment' THEN amount ELSE -amount END), 0) as balance
             FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')`,
            [req.user.id, clientId]
        );

        if (balance[0].balance < amount) {
            return res.status(400).json({ 
                error: `Solde insuffisant (${formatNumber(balance[0].balance)} FCFA disponible)` 
            });
        }

        // Enregistrer le paiement
        await connection.query(
            'INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, "client_account")',
            [sale_id, amount]
        );

        // Mettre à jour la vente
        await connection.query(
            'UPDATE sales SET status = "completed" WHERE id = ?',
            [sale_id]
        );

        // Ajouter la transaction
        await connection.query(
            `INSERT INTO cash_register 
             (user_id, transaction_type, amount, description, reference_id) 
             VALUES (?, 'payment', ?, ?, ?)`,
            [req.user.id, amount, `Paiement facture #${sale_id}`, clientId]
        );

        await connection.commit();
        res.json({ 
            message: '✅ Facture payée avec le compte client',
            remaining_balance: balance[0].balance - amount
        });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur POST /clients/:id/pay-invoice:', err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'index.html'));
});

initAndStart();