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
const QRCode = require('qrcode');

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

// ===== CACHE POUR LE COMPTAGE DES PRODUITS =====
const countCache = new Map();
const CACHE_TTL = 30000; // 30 secondes

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
            cachet_url LONGTEXT,
            signature_url LONGTEXT,
            tax_rate DECIMAL(5,2) DEFAULT 0.00,
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
            buy_price DECIMAL(15,2) DEFAULT 0,
            sell_price DECIMAL(15,2) DEFAULT 0,
            wholesale_price DECIMAL(15,2) DEFAULT 0,
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
            total_amount DECIMAL(15,2) NOT NULL,
            remise_pct DECIMAL(5,2) DEFAULT 0,
            acompte DECIMAL(15,2) DEFAULT 0,
            tax DECIMAL(15,2) DEFAULT 0,
            final_amount DECIMAL(15,2) NOT NULL,
            payment_method ENUM('cash','card','transfer') DEFAULT 'cash',
            status ENUM('completed','pending','cancelled') DEFAULT 'completed',
            due_date DATE NULL,
            notes TEXT,
            tax_rate DECIMAL(5,2) DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS sale_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sale_id INT NOT NULL,
            product_id INT NOT NULL,
            quantity INT NOT NULL,
            unit_price DECIMAL(15,2) NOT NULL,
            total_price DECIMAL(15,2) NOT NULL,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS payments (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sale_id INT NOT NULL,
            amount DECIMAL(15,2) NOT NULL,
            payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            payment_method ENUM('cash','card','transfer') DEFAULT 'cash',
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS cash_register (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            transaction_type ENUM('sale','purchase','expense','withdrawal','deposit','payment') NOT NULL,
            amount DECIMAL(15,2) NOT NULL,
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
            subtotal DECIMAL(15,2) NOT NULL,
            tax DECIMAL(15,2) DEFAULT 0,
            remise_pct DECIMAL(5,2) DEFAULT 0,
            acompte DECIMAL(15,2) DEFAULT 0,
            total DECIMAL(15,2) NOT NULL,
            notes TEXT,
            status ENUM('draft','sent','accepted','rejected') DEFAULT 'draft',
            tax_rate DECIMAL(5,2) DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS proforma_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            proforma_id INT NOT NULL,
            description VARCHAR(500) NOT NULL,
            quantity INT NOT NULL,
            unit_price DECIMAL(15,2) NOT NULL,
            total_price DECIMAL(15,2) NOT NULL,
            FOREIGN KEY (proforma_id) REFERENCES proforma_invoices(id) ON DELETE CASCADE
        )`);

        // ===== PERMISSIONS ET SOUS-COMPTES =====
        await pool.query(`CREATE TABLE IF NOT EXISTS permissions (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(50) NOT NULL UNIQUE,
            description VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

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

        await pool.query(`CREATE TABLE IF NOT EXISTS sub_user_permissions (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sub_user_id INT NOT NULL,
            permission_id INT NOT NULL,
            FOREIGN KEY (sub_user_id) REFERENCES sub_users(id) ON DELETE CASCADE,
            FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
            UNIQUE(sub_user_id, permission_id)
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS sub_user_audit (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sub_user_id INT NOT NULL,
            action VARCHAR(50) NOT NULL,
            details JSON,
            ip_address VARCHAR(45),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sub_user_id) REFERENCES sub_users(id) ON DELETE CASCADE
        )`);

        // ===== ORDERS =====
        await pool.query(`CREATE TABLE IF NOT EXISTS orders (
            id INT PRIMARY KEY AUTO_INCREMENT,
            customer_name VARCHAR(100) NOT NULL,
            customer_email VARCHAR(100),
            customer_phone VARCHAR(50),
            customer_address TEXT,
            order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            total_amount DECIMAL(15,2) NOT NULL,
            status ENUM('pending','confirmed','shipped','delivered','cancelled') DEFAULT 'pending',
            payment_method VARCHAR(50) DEFAULT 'cash',
            notes TEXT,
            sale_id INT NULL,
            user_id INT NOT NULL,
            delivery_id INT NULL,
            delivery_status ENUM('pending','assigned','picked_up','in_transit','delivered','failed') DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE SET NULL
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS order_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            order_id INT NOT NULL,
            product_id INT NOT NULL,
            quantity INT NOT NULL,
            unit_price DECIMAL(15,2) NOT NULL,
            total_price DECIMAL(15,2) NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        )`);

        // ===== DELIVERY =====
        await pool.query(`CREATE TABLE IF NOT EXISTS delivery_drivers (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            phone VARCHAR(50) NOT NULL,
            vehicle_type VARCHAR(50) DEFAULT 'moto',
            license_plate VARCHAR(50),
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS deliveries (
            id INT PRIMARY KEY AUTO_INCREMENT,
            order_id INT NOT NULL,
            driver_id INT,
            assigned_at TIMESTAMP NULL,
            pickup_address TEXT,
            delivery_address TEXT NOT NULL,
            status ENUM('pending','assigned','picked_up','in_transit','delivered','failed') DEFAULT 'pending',
            delivered_at TIMESTAMP NULL,
            tracking_code VARCHAR(50) UNIQUE,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (driver_id) REFERENCES delivery_drivers(id) ON DELETE SET NULL
        )`);

        // ===== INSERTION PERMISSIONS =====
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
                ('inventory_view', 'Voir l''inventaire'),
                ('inventory_manage', 'Gérer l''inventaire'),
                ('reports_view', 'Voir les rapports'),
                ('settings_view', 'Voir les paramètres'),
                ('settings_edit', 'Modifier les paramètres'),
                ('sub_users_manage', 'Gérer l''équipe'),
                ('orders_view', 'Voir les commandes en ligne'),
                ('orders_validate', 'Valider les commandes en ligne')
            `);
            console.log('✅ Permissions insérées avec succès');
        } catch (err) {
            console.error('❌ Erreur insertion permissions:', err.message);
        }

        // ===== VÉRIFICATION DES COLONNES MONÉTAIRES =====
        console.log('🔍 Vérification des colonnes DECIMAL...');
        const decimalColumns = [
            { table: 'sales', columns: ['total_amount', 'final_amount', 'tax', 'acompte'] },
            { table: 'sale_items', columns: ['unit_price', 'total_price'] },
            { table: 'payments', columns: ['amount'] },
            { table: 'cash_register', columns: ['amount'] },
            { table: 'proforma_invoices', columns: ['subtotal', 'tax', 'total', 'acompte'] },
            { table: 'proforma_items', columns: ['unit_price', 'total_price'] },
            { table: 'orders', columns: ['total_amount'] },
            { table: 'order_items', columns: ['unit_price', 'total_price'] }
        ];

        for (const item of decimalColumns) {
            for (const col of item.columns) {
                try {
                    const [rows] = await pool.query(`SHOW COLUMNS FROM ${item.table} LIKE '${col}'`);
                    if (rows.length > 0) {
                        const type = rows[0].Type;
                        if (type.match(/decimal\(\s*\d+\s*,\s*\d+\s*\)/i)) {
                            const match = type.match(/decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)/i);
                            if (match) {
                                const precision = parseInt(match[1]);
                                if (precision < 15) {
                                    await pool.query(`ALTER TABLE ${item.table} MODIFY COLUMN ${col} DECIMAL(15,2)`);
                                    console.log(`✅ Colonne ${item.table}.${col} passée à DECIMAL(15,2)`);
                                }
                            }
                        } else if (type.match(/int|bigint|float|double/i)) {
                            await pool.query(`ALTER TABLE ${item.table} MODIFY COLUMN ${col} DECIMAL(15,2)`);
                            console.log(`✅ Colonne ${item.table}.${col} passée à DECIMAL(15,2)`);
                        }
                    }
                } catch (err) {
                    console.log(`⚠️ Erreur pour ${item.table}.${col}:`, err.message);
                }
            }
        }
        console.log('✅ Colonnes monétaires vérifiées et ajustées');

        // ===== AJOUT DES COLONNES MANQUANTES (si elles n'existent pas) =====
        try { await pool.query(`ALTER TABLE sales ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE proforma_invoices ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE settings ADD COLUMN cachet_url TEXT NULL`); } catch(e) {}
        try { await pool.query(`ALTER TABLE settings ADD COLUMN signature_url TEXT NULL`); } catch(e) {}

        // ===== INDEX =====
        try { await pool.query(`CREATE INDEX idx_sales_user_id ON sales(user_id)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_sales_sale_date ON sales(sale_date)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_sales_status ON sales(status)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_products_user_id ON products(user_id)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_products_name ON products(name)`); } catch(e) {}
        try { await pool.query(`CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id)`); } catch(e) {}

        // ===== INDEX FULLTEXT pour recherche rapide =====
        try {
            await pool.query(`ALTER TABLE products ADD FULLTEXT INDEX ft_search (name, sku, barcode)`);
            console.log('✅ Index FULLTEXT ft_search ajouté (ou déjà existant)');
        } catch(e) {
            console.log('⚠️ Index FULLTEXT déjà présent ou erreur:', e.message);
        }

        console.log('✅ Tables prêtes avec index');

        app.listen(PORT, () => console.log(`🚀 Serveur sur http://localhost:${PORT}`));
    } catch (err) {
        console.error('❌ Erreur critique :', err.message);
        process.exit(1);
    }
}

// ========== MIDDLEWARE AUTHENTIFICATION ==========
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

// ===== FORMATAGE DES NOMBRES POUR PDF =====
function formatPDFNumber(number) {
    if (number === undefined || number === null || isNaN(number)) return '0';
    const rounded = Math.round(number);
    const str = rounded.toString();
    let result = '';
    let count = 0;
    for (let i = str.length - 1; i >= 0; i--) {
        result = str[i] + result;
        count++;
        if (count % 3 === 0 && i !== 0) {
            result = '.' + result;
        }
    }
    return result;
}

// ===== DÉSACTIVER LE CACHE POUR LES RÉPONSES API =====
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
        await pool.query(`INSERT INTO settings (user_id, company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, tax_rate, low_stock_alert, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [result.insertId, 'Mon Entreprise', '', '', '', '', '', '', '', '', 0, 5, 'FCFA']);
        res.status(201).json({ message: 'Utilisateur créé' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        let [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        let user = rows[0];
        let isSubUser = false;
        let subUserId = null;
        let permissions = [];

        if (user) {
            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });
            permissions = ['*'];
        } else {
            const [subRows] = await pool.query(
                `SELECT su.*, u.id as parent_user_id, u.name as parent_name 
                 FROM sub_users su 
                 JOIN users u ON su.parent_id = u.id 
                 WHERE su.email = ? AND su.is_active = 1`,
                [email]
            );
            if (subRows.length === 0) {
                return res.status(401).json({ error: 'Identifiants invalides ou compte désactivé' });
            }
            const subUser = subRows[0];
            const valid = await bcrypt.compare(password, subUser.password_hash);
            if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });
            isSubUser = true;
            subUserId = subUser.id;
            const [perms] = await pool.query(
                `SELECT p.name FROM sub_user_permissions sp JOIN permissions p ON sp.permission_id = p.id WHERE sp.sub_user_id = ?`,
                [subUser.id]
            );
            permissions = perms.map(p => p.name);
            user = {
                id: subUser.id,
                name: subUser.name,
                email: subUser.email,
                role: 'sub_user',
                parent_name: subUser.parent_name,
                parent_id: subUser.parent_id
            };
        }

        const token = jwt.sign({
            userId: isSubUser ? user.parent_id : user.id,
            subUserId: isSubUser ? subUserId : null,
            isSubUser: isSubUser,
            email: user.email,
            permissions: permissions
        }, JWT_SECRET, { expiresIn: '7d' });

        console.log('✅ Token généré pour:', user.email);
        console.log('🔑 Permissions:', permissions);

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role || 'sub_user',
                isSubUser: isSubUser,
                permissions: permissions
            }
        });
    } catch (err) {
        console.error('❌ Erreur login:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ========== ROUTES PUBLIQUES (BOUTIQUE) ==========
app.get('/api/public/products', async (req, res) => {
    const { shop, limit = 24, offset = 0, category, sort } = req.query;
    try {
        let whereClause = 'WHERE quantity > 0';
        const params = [];
        if (shop && !isNaN(shop)) {
            whereClause += ' AND user_id = ?';
            params.push(parseInt(shop));
        }
        if (category && !isNaN(category)) {
            whereClause += ' AND category_id = ?';
            params.push(parseInt(category));
        }
        let orderBy = 'ORDER BY name';
        if (sort === 'price_asc') orderBy = 'ORDER BY sell_price ASC';
        else if (sort === 'price_desc') orderBy = 'ORDER BY sell_price DESC';
        else if (sort === 'newest') orderBy = 'ORDER BY created_at DESC';

        const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM products ${whereClause}`, params);
        const total = countRows[0].total;
        const [rows] = await pool.query(
            `SELECT id, name, description, sell_price, wholesale_price, wholesale_quantity,
                    quantity, image_url, unit, category_id, created_at
             FROM products ${whereClause} ${orderBy} LIMIT ? OFFSET ?`,
            [...params, parseInt(limit), parseInt(offset)]
        );
        res.json({ products: rows, total, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/public/categories', async (req, res) => {
    const { shop } = req.query;
    if (!shop || isNaN(shop)) return res.json([]);
    try {
        const [rows] = await pool.query(
            `SELECT DISTINCT c.id, c.name
             FROM categories c
             JOIN products p ON p.category_id = c.id
             WHERE c.user_id = ? AND p.quantity > 0
             ORDER BY c.name`,
            [parseInt(shop)]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/public/settings', async (req, res) => {
    const { shop } = req.query;
    if (!shop || isNaN(shop)) {
        return res.status(400).json({ error: 'Paramètre shop invalide' });
    }
    try {
        const [rows] = await pool.query(
            `SELECT company_name, company_subtitle, company_activity, company_rc, 
                    company_address, company_phone, company_phone2, company_email, 
                    logo_url, cachet_url, signature_url, currency, tax_rate 
             FROM settings WHERE user_id = ?`,
            [parseInt(shop)]
        );
        if (rows.length === 0) {
            return res.json({
                company_name: 'Mon Entreprise',
                company_subtitle: '',
                company_activity: '',
                company_address: '',
                company_phone: '',
                company_phone2: '',
                company_email: '',
                logo_url: '',
                cachet_url: '',
                signature_url: '',
                currency: 'FCFA',
                tax_rate: 0
            });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Erreur GET /api/public/settings:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/store', (req, res) => {
    res.sendFile(path.join(__dirname, 'store.html'));
});

app.post('/api/public/orders', async (req, res) => {
    const { customer_name, customer_email, customer_phone, customer_address, items, payment_method, notes, shop } = req.body;
    if (!customer_name || !items || !items.length) {
        return res.status(400).json({ error: 'Nom client et articles requis' });
    }
    if (!shop || isNaN(shop)) {
        return res.status(400).json({ error: 'Identifiant boutique manquant' });
    }
    const userId = parseInt(shop);

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let total = 0;
        for (const item of items) {
            const [prod] = await connection.query(
                'SELECT sell_price, quantity FROM products WHERE id = ? AND user_id = ? FOR UPDATE',
                [item.product_id, userId]
            );
            if (!prod.length) throw new Error(`Produit ${item.product_id} inexistant`);
            if (prod[0].quantity < item.quantity) {
                throw new Error(`Stock insuffisant pour le produit ${item.product_id}`);
            }
            const unitPrice = item.unit_price || prod[0].sell_price;
            item.total_price = unitPrice * item.quantity;
            total += item.total_price;
        }

        const [orderResult] = await connection.query(
            `INSERT INTO orders 
             (customer_name, customer_email, customer_phone, customer_address, total_amount, payment_method, notes, status, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [customer_name, customer_email, customer_phone, customer_address, total, payment_method || 'cash', notes || '', userId]
        );
        const orderId = orderResult.insertId;

        for (const item of items) {
            await connection.query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
                 VALUES (?, ?, ?, ?, ?)`,
                [orderId, item.product_id, item.quantity, item.unit_price || 0, item.total_price]
            );
        }

        await connection.commit();
        res.status(201).json({ order_id: orderId, message: 'Commande enregistrée en attente de validation' });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur création commande:', err);
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.get('/api/public/orders/track', async (req, res) => {
    const { shop, order_id, phone } = req.query;
    if (!shop || !order_id || !phone) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    try {
        const [orderRows] = await pool.query(
            `SELECT id, customer_name, customer_phone, status, total_amount, created_at
             FROM orders WHERE id = ? AND user_id = ?`,
            [order_id, parseInt(shop)]
        );
        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Commande introuvable' });
        }
        const order = orderRows[0];
        const cleanStored = (order.customer_phone || '').replace(/\D/g, '');
        const cleanInput = phone.replace(/\D/g, '');
        if (!cleanStored || !cleanInput || 
            (!cleanStored.endsWith(cleanInput.slice(-8)) && !cleanInput.endsWith(cleanStored.slice(-8)))) {
            return res.status(403).json({ error: 'Numéro de téléphone incorrect pour cette commande' });
        }

        const [items] = await pool.query(
            `SELECT oi.quantity, oi.unit_price, oi.total_price, p.name as product_name
             FROM order_items oi JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = ?`,
            [order_id]
        );

        const [delivery] = await pool.query(
            `SELECT d.*, dr.name as driver_name, dr.phone as driver_phone
             FROM deliveries d
             LEFT JOIN delivery_drivers dr ON d.driver_id = dr.id
             WHERE d.order_id = ?`,
            [order_id]
        );

        res.json({
            id: order.id,
            status: order.status,
            total_amount: order.total_amount,
            created_at: order.created_at,
            items: items,
            delivery: delivery[0] || null
        });
    } catch (err) {
        console.error('Erreur suivi commande:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTES LIVREURS ==========
app.get('/api/delivery/drivers', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM delivery_drivers WHERE user_id = ? ORDER BY name', [req.user.id]);
    res.json(rows);
});

app.post('/api/delivery/drivers', authenticate, async (req, res) => {
    const { name, phone, vehicle_type, license_plate } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone requis' });
    const [result] = await pool.query(
        'INSERT INTO delivery_drivers (user_id, name, phone, vehicle_type, license_plate) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, name, phone, vehicle_type || 'moto', license_plate || null]
    );
    res.status(201).json({ id: result.insertId, message: 'Livreur créé' });
});

app.put('/api/delivery/drivers/:id', authenticate, async (req, res) => {
    const { name, phone, vehicle_type, license_plate, is_active } = req.body;
    await pool.query(
        `UPDATE delivery_drivers SET name=?, phone=?, vehicle_type=?, license_plate=?, is_active=? 
         WHERE id=? AND user_id=?`,
        [name, phone, vehicle_type, license_plate, is_active !== undefined ? is_active : 1, req.params.id, req.user.id]
    );
    res.json({ message: 'Livreur mis à jour' });
});

app.delete('/api/delivery/drivers/:id', authenticate, async (req, res) => {
    await pool.query('DELETE FROM delivery_drivers WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ message: 'Livreur supprimé' });
});

// ========== ROUTES LIVRAISONS ==========
app.get('/api/delivery/requests', authenticate, async (req, res) => {
    const [rows] = await pool.query(
        `SELECT d.*, o.customer_name, o.customer_address, o.total_amount,
                dr.name as driver_name, dr.phone as driver_phone
         FROM deliveries d
         LEFT JOIN orders o ON d.order_id = o.id
         LEFT JOIN delivery_drivers dr ON d.driver_id = dr.id
         WHERE o.user_id = ?
         ORDER BY d.created_at DESC`,
        [req.user.id]
    );
    res.json(rows);
});

app.post('/api/delivery/requests', authenticate, async (req, res) => {
    const { order_id, delivery_address, notes } = req.body;
    if (!order_id || !delivery_address) {
        return res.status(400).json({ error: 'Commande et adresse requis' });
    }
    const [orderCheck] = await pool.query('SELECT id FROM orders WHERE id=? AND user_id=?', [order_id, req.user.id]);
    if (!orderCheck.length) return res.status(404).json({ error: 'Commande non trouvée' });

    const trackingCode = 'TRK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const [result] = await pool.query(
        `INSERT INTO deliveries (order_id, delivery_address, tracking_code, notes)
         VALUES (?, ?, ?, ?)`,
        [order_id, delivery_address, trackingCode, notes || null]
    );
    await pool.query('UPDATE orders SET delivery_id = ? WHERE id = ?', [result.insertId, order_id]);

    res.status(201).json({ id: result.insertId, tracking_code: trackingCode });
});

app.put('/api/delivery/requests/:id', authenticate, async (req, res) => {
    const { driver_id, status, notes } = req.body;
    const deliveryId = req.params.id;
    const [check] = await pool.query(
        `SELECT d.id FROM deliveries d JOIN orders o ON d.order_id = o.id WHERE d.id = ? AND o.user_id = ?`,
        [deliveryId, req.user.id]
    );
    if (!check.length) return res.status(404).json({ error: 'Livraison non trouvée' });

    let deliveredAt = null;
    if (status === 'delivered') deliveredAt = new Date();

    await pool.query(
        `UPDATE deliveries SET driver_id = ?, status = ?, notes = ?, delivered_at = ? WHERE id = ?`,
        [driver_id || null, status || 'pending', notes || null, deliveredAt, deliveryId]
    );
    if (status) {
        await pool.query('UPDATE orders SET delivery_status = ? WHERE delivery_id = ?', [status, deliveryId]);
    }

    res.json({ message: 'Livraison mise à jour' });
});

app.delete('/api/delivery/requests/:id', authenticate, async (req, res) => {
    const deliveryId = req.params.id;
    const [check] = await pool.query(
        `SELECT d.id FROM deliveries d JOIN orders o ON d.order_id = o.id WHERE d.id = ? AND o.user_id = ?`,
        [deliveryId, req.user.id]
    );
    if (!check.length) return res.status(404).json({ error: 'Livraison non trouvée' });
    await pool.query('DELETE FROM deliveries WHERE id = ?', [deliveryId]);
    await pool.query('UPDATE orders SET delivery_id = NULL, delivery_status = NULL WHERE delivery_id = ?', [deliveryId]);
    res.json({ message: 'Livraison supprimée' });
});

app.get('/api/public/track-delivery', async (req, res) => {
    const { tracking_code } = req.query;
    if (!tracking_code) return res.status(400).json({ error: 'Code de suivi requis' });
    const [rows] = await pool.query(
        `SELECT d.*, o.customer_name, o.customer_phone, o.customer_address,
                dr.name as driver_name, dr.phone as driver_phone
         FROM deliveries d
         LEFT JOIN orders o ON d.order_id = o.id
         LEFT JOIN delivery_drivers dr ON d.driver_id = dr.id
         WHERE d.tracking_code = ?`,
        [tracking_code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Code de suivi invalide' });
    res.json(rows[0]);
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

// ========== ROUTES PRODUITS (UNIFIÉES) ==========

// 1. GET /api/products (liste paginée avec recherche LIKE simple)
app.get('/api/products', authenticate, async (req, res) => {
    const { limit, offset, search = '' } = req.query;
    const userId = req.user.id;

    let sql = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.user_id = ?';
    const params = [userId];

    if (search) {
        sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
    }

    sql += ' ORDER BY p.name';

    if (limit && offset) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));
    }

    const [rows] = await pool.query(sql, params);
    res.json(rows);
});

// 2. GET /api/products/search (recherche FULLTEXT avec pagination)
app.get('/api/products/search', authenticate, async (req, res) => {
    const { q, lowStock, limit = 30, offset = 0 } = req.query;
    const userId = req.user.id;

    let sql = `SELECT p.*, c.name as category_name 
               FROM products p 
               LEFT JOIN categories c ON p.category_id = c.id 
               WHERE p.user_id = ?`;
    const params = [userId];

    if (q && q.trim() !== '') {
        const searchTerm = q.trim().split(' ').map(word => `+${word}*`).join(' ');
        sql += ` AND MATCH(p.name, p.sku, p.barcode) AGAINST (? IN BOOLEAN MODE)`;
        params.push(searchTerm);
    }
    if (lowStock === 'true') {
        sql += ' AND p.quantity <= p.reorder_level';
    }

    sql += ' ORDER BY p.name LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    try {
        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('❌ Erreur search products:', err);
        res.status(500).json({ error: err.message });
    }
});

// 3. GET /api/products/count (avec cache)
app.get('/api/products/count', authenticate, async (req, res) => {
    const { q, lowStock } = req.query;
    const userId = req.user.id;
    const cacheKey = `count_${userId}_${q || ''}_${lowStock || ''}`;

    const cached = countCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json({ count: cached.count });
    }

    let sql = 'SELECT COUNT(*) as count FROM products WHERE user_id = ?';
    const params = [userId];

    if (q && q.trim() !== '') {
        const searchTerm = q.trim().split(' ').map(word => `+${word}*`).join(' ');
        sql += ` AND MATCH(name, sku, barcode) AGAINST (? IN BOOLEAN MODE)`;
        params.push(searchTerm);
    }
    if (lowStock === 'true') {
        sql += ' AND quantity <= reorder_level';
    }

    try {
        const [rows] = await pool.query(sql, params);
        const count = rows[0].count;
        countCache.set(cacheKey, { count, timestamp: Date.now() });
        res.json({ count });
    } catch (err) {
        console.error('❌ Erreur count products:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4. GET /api/products/:id (récupération unique)
app.get('/api/products/:id', authenticate, async (req, res) => {
    const productId = parseInt(req.params.id);
    const userId = req.user.id;

    if (isNaN(productId)) {
        return res.status(400).json({ error: 'ID invalide' });
    }

    try {
        const [rows] = await pool.query(
            `SELECT p.*, c.name as category_name 
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             WHERE p.id = ? AND p.user_id = ?`,
            [productId, userId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Produit non trouvé' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('❌ Erreur get product:', err);
        res.status(500).json({ error: err.message });
    }
});

// 5. GET /api/products/barcode/:code
app.get('/api/products/barcode/:code', authenticate, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM products WHERE user_id=? AND barcode=?', [req.user.id, req.params.code]);
    if (rows.length === 0) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json(rows[0]);
});

// 6. POST /api/products (création)
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

// 7. PUT /api/products/:id (modification)
app.put('/api/products/:id', authenticate, async (req, res) => {
    const productId = parseInt(req.params.id);
    const userId = req.user.id;

    console.log(`🔍 Modification produit ID: ${productId} par utilisateur ${userId}`);

    const [existing] = await pool.query('SELECT id, name, user_id FROM products WHERE id = ? AND user_id = ?', [productId, userId]);
    if (existing.length === 0) {
        console.log(`❌ Produit ${productId} non trouvé pour l'utilisateur ${userId}`);
        return res.status(404).json({ error: 'Produit non trouvé', details: `ID: ${productId}, User: ${userId}` });
    }
    console.log(`✅ Produit trouvé: ${existing[0].name} (ID: ${productId})`);

    const { sku, barcode, name, description, category_id, category_name, supplier_id, quantity, unit, reorder_level, buy_price, sell_price, wholesale_price, wholesale_quantity, location, image_url } = req.body;

    let finalCatId = category_id;
    if (category_name && category_name.trim() !== '') {
        let [cat] = await pool.query('SELECT id FROM categories WHERE user_id=? AND name=?', [userId, category_name]);
        if (cat.length === 0) {
            const [catResult] = await pool.query('INSERT INTO categories (user_id, name) VALUES (?,?)', [userId, category_name]);
            finalCatId = catResult.insertId;
        } else {
            finalCatId = cat[0].id;
        }
    }
    const supId = supplier_id ? parseInt(supplier_id) : null;

    try {
        await pool.query(`
            UPDATE products SET 
                sku=?, barcode=?, name=?, description=?, category_id=?, 
                supplier_id=?, quantity=?, unit=?, reorder_level=?, 
                buy_price=?, sell_price=?, wholesale_price=?, wholesale_quantity=?, 
                location=?, image_url=?
            WHERE id=? AND user_id=?`,
            [sku, barcode || null, name, description || '', finalCatId || null,
             supId, quantity || 0, unit || 'pièce', reorder_level || 5,
             buy_price || 0, sell_price || 0, wholesale_price || 0, wholesale_quantity || 0,
             location || null, image_url || null,
             productId, userId]
        );
        console.log(`✅ Produit ${productId} mis à jour avec succès`);
        res.json({ message: 'Mis à jour' });
    } catch (err) {
        console.error('❌ Erreur mise à jour:', err);
        res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    }
});

// 8. DELETE /api/products/:id (suppression en cascade)
app.delete('/api/products/:id', authenticate, async (req, res) => {
    const productId = parseInt(req.params.id);
    const userId = req.user.id;

    console.log(`🗑️ Suppression du produit ID: ${productId} par utilisateur ${userId}`);

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT id, name FROM products WHERE id = ? AND user_id = ?', [productId, userId]);
        if (existing.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Produit non trouvé' });
        }

        await connection.query('DELETE FROM sale_items WHERE product_id = ?', [productId]);
        await connection.query('DELETE FROM order_items WHERE product_id = ?', [productId]);
        await connection.query('DELETE FROM stock_movements WHERE product_id = ?', [productId]);
        await connection.query('DELETE FROM products WHERE id = ? AND user_id = ?', [productId, userId]);

        await connection.commit();
        console.log(`✅ Produit ${productId} (${existing[0].name}) supprimé avec ses dépendances`);
        res.json({ message: 'Produit supprimé avec succès', product_name: existing[0].name });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur suppression produit:', err);
        res.status(500).json({ error: 'Erreur lors de la suppression du produit', details: err.message });
    } finally {
        connection.release();
    }
});

// ========== ROUTES VENTES ==========
app.post('/api/sales', authenticate, async (req, res) => {
    console.log('📦 Données reçues:', req.body);

    const { client_name = '', client_email = '', client_phone = '', client_address = '', items = [], remise_pct = 0, acompte = 0, payment_method = 'cash', status = 'completed', due_date = null, is_wholesale = false } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Aucun produit dans le panier' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let client_id = null;
        if (client_name && client_name.trim() !== '') {
            let [existing] = await connection.query('SELECT id FROM clients WHERE user_id=? AND name=?', [req.user.id, client_name]);
            if (existing.length > 0) {
                client_id = existing[0].id;
            } else {
                const [result] = await connection.query('INSERT INTO clients (user_id, name, email, phone, address) VALUES (?, ?, ?, ?, ?)', [req.user.id, client_name, client_email || null, client_phone || null, client_address || null]);
                client_id = result.insertId;
            }
        }

        let subtotal = 0;
        for (let item of items) {
            if (!item.product_id || !item.quantity || !item.unit_price) {
                throw new Error(`Produit ${item.product_id} invalide`);
            }
            const [prod] = await connection.query('SELECT quantity FROM products WHERE id=? AND user_id=? FOR UPDATE', [item.product_id, req.user.id]);
            if (prod.length === 0) {
                throw new Error(`Produit ${item.product_id} inexistant`);
            }
            if (prod[0].quantity < item.quantity) {
                throw new Error(`Stock insuffisant pour le produit ${item.product_id}`);
            }
            item.total_price = item.unit_price * item.quantity;
            subtotal += item.total_price;
        }

        const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [req.user.id]);
        const tax_rate = settings[0]?.tax_rate !== null && settings[0]?.tax_rate !== undefined ? parseFloat(settings[0].tax_rate) : 0;

        const tax = subtotal * (tax_rate / 100);
        const remise_valeur = (remise_pct || 0) / 100 * subtotal;
        const total_apres_remise = subtotal - remise_valeur;
        let final_amount = total_apres_remise + tax - (acompte || 0);

        if (isNaN(final_amount) || !isFinite(final_amount) || final_amount < 0) {
            final_amount = 0;
        }
        if (final_amount > 999999999999) {
            final_amount = 999999999999;
        }

        const finalStatus = status === 'pending' ? 'pending' : 'completed';
        const [saleResult] = await connection.query(`
            INSERT INTO sales 
            (user_id, client_id, total_amount, remise_pct, acompte, tax, final_amount, payment_method, status, due_date, notes, tax_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, client_id, subtotal, remise_pct || 0, acompte || 0, tax, final_amount, payment_method || 'cash', finalStatus, due_date || null, is_wholesale ? 'VENTE EN GROS' : null, tax_rate]
        );
        const sale_id = saleResult.insertId;

        for (let item of items) {
            await connection.query(
                `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)`,
                [sale_id, item.product_id, item.quantity, item.unit_price, item.total_price]
            );

            const [prodBefore] = await connection.query('SELECT quantity FROM products WHERE id=? FOR UPDATE', [item.product_id]);
            const oldQty = prodBefore[0].quantity;
            const newQty = oldQty - item.quantity;
            await connection.query('UPDATE products SET quantity=? WHERE id=?', [newQty, item.product_id]);
            await connection.query(
                `INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, reference, notes)
                 VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)`,
                [item.product_id, req.user.id, -item.quantity, oldQty, newQty, `VENTE #${sale_id}`, is_wholesale ? 'Vente en gros' : null]
            );
        }

        if (finalStatus === 'completed') {
            await connection.query('INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)', [sale_id, final_amount, payment_method || 'cash']);
            await connection.query(`INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) VALUES (?, 'sale', ?, ?, ?)`, [req.user.id, final_amount, `Vente #${sale_id}`, sale_id]);
        }

        await connection.commit();
        res.status(201).json({ sale_id, final_amount, status: finalStatus, message: 'Vente enregistrée avec succès' });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur vente:', err);
        res.status(400).json({ error: err.message, details: err.stack });
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
    const { remise_pct, acompte, client_name, client_email, client_phone, client_address } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [saleRows] = await connection.query('SELECT * FROM sales WHERE id = ? AND user_id = ? FOR UPDATE', [req.params.id, req.user.id]);
        if (saleRows.length === 0) {
            return res.status(404).json({ error: 'Vente non trouvée' });
        }
        const sale = saleRows[0];

        let client_id = sale.client_id;
        if (client_name !== undefined) {
            if (client_name && client_name.trim() !== '') {
                let [existing] = await connection.query('SELECT id FROM clients WHERE user_id = ? AND name = ?', [req.user.id, client_name.trim()]);
                if (existing.length > 0) {
                    client_id = existing[0].id;
                } else {
                    const [result] = await connection.query('INSERT INTO clients (user_id, name, email, phone, address) VALUES (?, ?, ?, ?, ?)', [req.user.id, client_name.trim(), client_email || null, client_phone || null, client_address || null]);
                    client_id = result.insertId;
                }
            } else {
                client_id = null;
            }
        }

        const newRemise = remise_pct !== undefined ? remise_pct : sale.remise_pct;
        const newAcompte = acompte !== undefined ? acompte : sale.acompte;
        const remise_valeur = (newRemise || 0) / 100 * sale.total_amount;
        const total_apres_remise = sale.total_amount - remise_valeur;
        let new_final = total_apres_remise + sale.tax - (newAcompte || 0);

        if (isNaN(new_final) || !isFinite(new_final) || new_final < 0) {
            new_final = 0;
        }
        if (new_final > 999999999999) {
            new_final = 999999999999;
        }

        await connection.query(
            `UPDATE sales SET remise_pct = ?, acompte = ?, final_amount = ?, client_id = ? WHERE id = ?`,
            [newRemise, newAcompte, new_final, client_id, req.params.id]
        );

        await connection.commit();
        res.json({ message: 'Vente modifiée avec succès', client_id: client_id, final_amount: new_final });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur modification vente:', err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.put('/api/sales/:id/items', authenticate, async (req, res) => {
    const saleId = req.params.id;
    const { items } = req.body;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const [saleExists] = await connection.query('SELECT id FROM sales WHERE id = ? AND user_id = ?', [saleId, req.user.id]);
            if (saleExists.length === 0) {
                return res.status(404).json({ error: 'Vente non trouvée' });
            }

            await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
            const [saleRows] = await connection.query('SELECT * FROM sales WHERE id = ? FOR UPDATE', [saleId]);
            const sale = saleRows[0];

            const [oldItems] = await connection.query('SELECT product_id, quantity FROM sale_items WHERE sale_id = ?', [saleId]);
            const oldMap = {};
            oldItems.forEach(item => { oldMap[item.product_id] = item.quantity; });

            await connection.query('DELETE FROM sale_items WHERE sale_id = ?', [saleId]);

            let subtotal = 0;
            for (const item of items) {
                if (!item.product_id || !item.quantity || !item.unit_price) {
                    throw new Error('Données d\'article invalides');
                }
                const oldQty = oldMap[item.product_id] || 0;
                const newQty = item.quantity;
                const diff = newQty - oldQty;

                if (diff > 0) {
                    const [prod] = await connection.query('SELECT quantity FROM products WHERE id = ? AND user_id = ? FOR UPDATE', [item.product_id, req.user.id]);
                    if (prod.length === 0) throw new Error(`Produit ${item.product_id} inexistant`);
                    if (prod[0].quantity < diff) {
                        throw new Error(`Stock insuffisant pour le produit ${item.product_id}`);
                    }
                    await connection.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [diff, item.product_id]);
                    await connection.query(
                        `INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, reference, notes)
                         VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)`,
                        [item.product_id, req.user.id, -diff, prod[0].quantity, prod[0].quantity - diff, `MODIFICATION VENTE #${saleId}`, 'Ajustement stock']
                    );
                } else if (diff < 0) {
                    await connection.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [-diff, item.product_id]);
                    const [prod] = await connection.query('SELECT quantity FROM products WHERE id = ? FOR UPDATE', [item.product_id]);
                    await connection.query(
                        `INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, reference, notes)
                         VALUES (?, ?, 'return', ?, ?, ?, ?, ?)`,
                        [item.product_id, req.user.id, -diff, prod[0].quantity + diff, prod[0].quantity, `MODIFICATION VENTE #${saleId}`, 'Retour stock']
                    );
                }

                const total_price = item.quantity * item.unit_price;
                await connection.query(
                    'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)',
                    [saleId, item.product_id, item.quantity, item.unit_price, total_price]
                );
                subtotal += total_price;
            }

            const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [req.user.id]);
            const tax_rate = settings[0]?.tax_rate !== null && settings[0]?.tax_rate !== undefined ? parseFloat(settings[0].tax_rate) : 0;
            const tax = subtotal * (tax_rate / 100);
            const remise_valeur = (sale.remise_pct || 0) / 100 * subtotal;
            const total_apres_remise = subtotal - remise_valeur;
            const final_amount = total_apres_remise + tax - (sale.acompte || 0);

            await connection.query(
                'UPDATE sales SET total_amount = ?, tax = ?, final_amount = ? WHERE id = ?',
                [subtotal, tax, final_amount, saleId]
            );

            await connection.commit();
            res.json({ message: 'Vente modifiée avec succès', final_amount });
            return;
        } catch (err) {
            await connection.rollback();
            console.error(`Tentative ${attempts} échouée:`, err.message);
            if (attempts < maxAttempts && err.code === 'ER_LOCK_WAIT_TIMEOUT') {
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
            res.status(400).json({ error: err.message });
            return;
        } finally {
            connection.release();
        }
    }
});

app.post('/api/sales/:id/payment', authenticate, async (req, res) => {
    const { amount, payment_method } = req.body;
    const saleId = req.params.id;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [saleRows] = await connection.query('SELECT * FROM sales WHERE id = ? AND user_id = ? FOR UPDATE', [saleId, req.user.id]);
        if (saleRows.length === 0) {
            return res.status(404).json({ error: 'Facture non trouvée' });
        }
        const sale = saleRows[0];

        if (sale.status === 'completed') {
            return res.status(400).json({ error: 'Cette facture est déjà réglée' });
        }

        const [paidRows] = await connection.query('SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE sale_id = ?', [saleId]);
        const totalPaid = parseFloat(paidRows[0].total_paid);
        const remaining = parseFloat(sale.final_amount) - totalPaid;
        const paymentAmount = parseFloat(amount);

        if (isNaN(paymentAmount) || paymentAmount <= 0) {
            return res.status(400).json({ error: 'Montant invalide' });
        }
        if (paymentAmount > remaining) {
            return res.status(400).json({ error: `Le montant dépasse le reste à payer (${remaining} FCFA)` });
        }

        await connection.query('INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)', [saleId, paymentAmount, payment_method || 'cash']);
        await connection.query(`INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) VALUES (?, 'deposit', ?, ?, ?)`, [req.user.id, paymentAmount, `Règlement facture #${saleId}`, saleId]);

        const newTotalPaid = totalPaid + paymentAmount;
        let newStatus = sale.status;
        if (newTotalPaid >= parseFloat(sale.final_amount) - 0.01) {
            await connection.query('UPDATE sales SET status = ? WHERE id = ?', ['completed', saleId]);
            newStatus = 'completed';
        }

        await connection.commit();
        res.json({
            message: '✅ Règlement enregistré',
            remaining: parseFloat(sale.final_amount) - newTotalPaid,
            status: newStatus,
            paid: newTotalPaid
        });
    } catch (err) {
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
    const userId = req.user.id;
    try {
        const [results] = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM products WHERE user_id = ?) AS totalProducts,
                (SELECT COUNT(*) FROM products WHERE user_id = ? AND quantity <= reorder_level) AS lowStock,
                (SELECT COALESCE(SUM(quantity * buy_price), 0) FROM products WHERE user_id = ?) AS inventoryValue,
                (SELECT COALESCE(SUM(final_amount), 0) FROM sales WHERE user_id = ? AND DATE(sale_date) = CURDATE() AND status = 'completed') AS todaySales,
                (SELECT COALESCE(SUM(final_amount), 0) FROM sales WHERE user_id = ? AND MONTH(sale_date) = MONTH(CURDATE()) AND YEAR(sale_date) = YEAR(CURDATE()) AND status = 'completed') AS monthSales
        `, [userId, userId, userId, userId, userId]);
        const [topProducts] = await pool.query(
            `SELECT p.name, SUM(si.quantity) as qte 
             FROM sale_items si 
             JOIN products p ON si.product_id = p.id 
             JOIN sales s ON si.sale_id = s.id 
             WHERE s.user_id = ? AND s.status = 'completed' 
             GROUP BY p.id ORDER BY qte DESC LIMIT 5`,
            [userId]
        );
        const [recentSales] = await pool.query(
            `SELECT s.id, s.final_amount, s.sale_date, c.name as client_name 
             FROM sales s 
             LEFT JOIN clients c ON s.client_id = c.id 
             WHERE s.user_id = ? 
             ORDER BY s.sale_date DESC LIMIT 5`,
            [userId]
        );
        res.json({
            ...results[0],
            topProducts: topProducts || [],
            recentSales: recentSales || []
        });
    } catch (err) {
        console.error('Dashboard error:', err);
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

// ========== ROUTES PARAMÈTRES ==========
app.get('/api/settings', authenticate, async (req, res) => {
    try {
        let [rows] = await pool.query('SELECT * FROM settings WHERE user_id=?', [req.user.id]);

        if (rows.length === 0) {
            await pool.query(`INSERT INTO settings (user_id, company_name, company_subtitle, company_activity, company_rc, company_address, company_phone, company_phone2, company_email, logo_url, cachet_url, signature_url, tax_rate, low_stock_alert, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.user.id, 'Mon Entreprise', '', '', '', '', '', '', '', '', '', '', 0, 5, 'FCFA']);
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
            cachet_url: settings.cachet_url || '',
            signature_url: settings.signature_url || '',
            tax_rate: settings.tax_rate !== null && settings.tax_rate !== undefined ? parseFloat(settings.tax_rate) : 0,
            low_stock_alert: parseInt(settings.low_stock_alert) || 5,
            currency: settings.currency || 'FCFA'
        });
    } catch (err) {
        console.error('❌ Erreur GET /settings:', err);
        res.status(500).json({ error: 'Erreur lors du chargement des paramètres.' });
    }
});
app.put('/api/settings', authenticate, async (req, res) => {
    const {
        company_name, company_subtitle, company_activity, company_rc,
        company_address, company_phone, company_phone2, company_email,
        logo_url, cachet_url, signature_url, tax_rate, low_stock_alert, currency
    } = req.body;

    console.log('📥 PUT /settings reçu:', {
        company_name,
        cachet_url: cachet_url ? '✅ Présent (longueur: ' + cachet_url.length + ')' : '❌ Vide',
        signature_url: signature_url ? '✅ Présent (longueur: ' + signature_url.length + ')' : '❌ Vide'
    });

    let taxRateToSave;
    if (tax_rate === undefined || tax_rate === null || tax_rate === '') {
        taxRateToSave = 0;
    } else {
        taxRateToSave = parseFloat(tax_rate);
        if (isNaN(taxRateToSave)) {
            return res.status(400).json({ error: 'Le taux de TVA doit être un nombre valide.' });
        }
    }

    try {
        const result = await pool.query(
            `UPDATE settings SET 
                company_name = ?, company_subtitle = ?, company_activity = ?, company_rc = ?, 
                company_address = ?, company_phone = ?, company_phone2 = ?, company_email = ?, 
                logo_url = ?, cachet_url = ?, signature_url = ?,
                tax_rate = ?, low_stock_alert = ?, currency = ? 
             WHERE user_id = ?`,
            [
                company_name, company_subtitle, company_activity, company_rc,
                company_address, company_phone, company_phone2, company_email,
                logo_url, cachet_url || null, signature_url || null,
                taxRateToSave,
                parseInt(low_stock_alert) || 5,
                currency || 'FCFA',
                req.user.id
            ]
        );
        console.log('✅ Mise à jour réussie, result:', result);
        res.json({ message: 'Paramètres mis à jour avec succès' });
    } catch (err) {
        console.error('❌ Erreur PUT /settings:', err);
        console.error('❌ SQL Error details:', err.sql, err.sqlMessage);
        res.status(500).json({ error: 'Erreur lors de la mise à jour des paramètres: ' + err.message });
    }
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

        const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [req.user.id]);
        const tax_rate = settings[0]?.tax_rate !== null && settings[0]?.tax_rate !== undefined ? parseFloat(settings[0].tax_rate) : 0;

        const tax = subtotal * (tax_rate / 100);
        const remise_valeur = (remise_pct || 0) / 100 * subtotal;
        const total_apres_remise = subtotal - remise_valeur;
        const total = total_apres_remise + tax - (acompte || 0);

        const proformaNumber = await getNextProformaNumber(req.user.id);

        const [result] = await connection.query(`
            INSERT INTO proforma_invoices 
            (user_id, proforma_number, client_name, client_email, client_phone, client_address, 
             subtotal, tax, remise_pct, acompte, total, valid_until, notes, status, tax_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, proformaNumber, client_name || '', client_email || '', client_phone || '', client_address || '',
             subtotal, tax, remise_pct || 0, acompte || 0, total, valid_until || null, notes || '',
             'draft', tax_rate]
        );

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
// ===== ROUTE ADMIN : COMPTER LES COMMANDES EN ATTENTE =====
app.get('/api/admin/orders/pending-count', authenticate, async (req, res) => {
    const userId = req.user.id;
    try {
        const [rows] = await pool.query(
            'SELECT COUNT(*) as count FROM orders WHERE user_id = ? AND status = ?',
            [userId, 'pending']
        );
        res.json({ count: rows[0].count || 0 });
    } catch (err) {
        console.error('Erreur comptage commandes en attente:', err);
        res.status(500).json({ error: err.message });
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
// ========== ROUTE PROFORMA PDF (VERSION COMPLÈTE ET AUTONOME) ==========
app.get('/api/proforma/:id/pdf', authenticate, async (req, res) => {
    try {
        const proformaId = req.params.id;

        // 1. Récupérer les infos de la proforma
        const [invoiceRows] = await pool.query(`
            SELECT * FROM proforma_invoices 
            WHERE id = ? AND user_id = ?
        `, [proformaId, req.user.id]);

        if (invoiceRows.length === 0) {
            return res.status(404).json({ error: 'Proforma non trouvée' });
        }
        const invoice = invoiceRows[0];

        // 2. Récupérer les articles
        const [items] = await pool.query(
            'SELECT * FROM proforma_items WHERE proforma_id = ?',
            [proformaId]
        );

        // 3. Récupérer les paramètres de la société
        const [settingsRows] = await pool.query(
            'SELECT * FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const company = settingsRows[0] || {
            company_name: 'Mon Entreprise',
            currency: 'FCFA'
        };

        // 4. Récupérer le cachet et la signature
        const [userSettings] = await pool.query(
            'SELECT cachet_url, signature_url FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const userCachet = userSettings[0]?.cachet_url || null;
        const userSignature = userSettings[0]?.signature_url || null;
        const hasCachet = userCachet && userCachet.trim() !== '';
        const hasSignature = userSignature && userSignature.trim() !== '';

        // 5. Créer le document PDF
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=proforma_${invoice.proforma_number}.pdf`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        doc.pipe(res);

        // ============================================================
        // FONCTION LOCALE POUR L'EN-TÊTE (si drawCompanyHeader n'est pas définie globalement)
        // ============================================================
        async function drawCompanyHeaderLocal(doc, company, startY = 45) {
            const fullWidth = 500;
            const headerHeight = 110;
            doc.rect(50, startY, fullWidth, headerHeight).fill('#ffffff');

            let textStartX = 50;
            let textWidth = 500;

            if (company.logo_url && company.logo_url.trim() !== '') {
                try {
                    const logoBuffer = await fetchImage(company.logo_url);
                    doc.image(logoBuffer, 50, startY + 5, { width: 80 });
                    textStartX = 150;
                    textWidth = 400;
                } catch(e) { /* ignorer */ }
            }

            doc.fillColor('#2c3e50');
            doc.fontSize(18).font('Helvetica-Bold')
               .text(company.company_name, textStartX, startY + 10, { width: textWidth - 20, align: 'center' });

            let currentY = startY + 35;
            if (company.company_subtitle && company.company_subtitle.trim() !== '') {
                doc.fontSize(10).font('Helvetica')
                   .text(company.company_subtitle, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_activity && company.company_activity.trim() !== '') {
                doc.fontSize(9).font('Helvetica-Oblique')
                   .text(company.company_activity, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_rc && company.company_rc.trim() !== '') {
                doc.fontSize(8).font('Helvetica')
                   .text(company.company_rc, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_address && company.company_address.trim() !== '') {
                doc.fontSize(9).font('Helvetica')
                   .text(company.company_address, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }

            let phoneLine = '';
            if (company.company_phone) phoneLine += `Tél : ${company.company_phone}`;
            if (company.company_phone2) phoneLine += ` // ${company.company_phone2}`;
            if (phoneLine) {
                doc.fontSize(9).font('Helvetica')
                   .text(phoneLine, textStartX, currentY, { width: textWidth - 20, align: 'center' });
            }

            doc.moveTo(50, startY + headerHeight + 5)
               .lineTo(550, startY + headerHeight + 5)
               .stroke('#cccccc');

            return startY + headerHeight + 20;
        }

        // ============================================================
        // EN-TÊTE (société)
        // ============================================================
        let y = await drawCompanyHeaderLocal(doc, company);

        // Titre
        doc.fillColor('#2c6e9e').fontSize(20).font('Helvetica-Bold')
           .text(`FACTURE PROFORMA N° ${invoice.proforma_number}`, 50, y, { align: 'center' });
        y += 30;

        // ============================================================
        // BLOC CLIENT / DÉTAILS
        // ============================================================
        doc.rect(50, y, 500, 80).fill('#f5f7fa').stroke('#e0e4e8', 0.5);
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('CLIENT', 60, y + 8);
        doc.fillColor('#3a4a5a').fontSize(11).font('Helvetica')
           .text(invoice.client_name || 'Client particulier', 60, y + 25);
        let clientY = y + 42;
        if (invoice.client_address) {
            doc.fontSize(9).font('Helvetica').text(invoice.client_address, 60, clientY);
            clientY += 16;
        }
        if (invoice.client_email) {
            doc.fontSize(9).font('Helvetica').text(`Email : ${invoice.client_email}`, 60, clientY);
            clientY += 16;
        }
        if (invoice.client_phone) {
            doc.fontSize(9).font('Helvetica').text(`Tél : ${invoice.client_phone}`, 60, clientY);
        }

        const rightX = 350;
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('DÉTAILS PROFORMA', rightX, y + 8);
        doc.fillColor('#3a4a5a').fontSize(10).font('Helvetica')
           .text(`Date : ${new Date(invoice.issue_date).toLocaleDateString('fr-FR')}`, rightX, y + 25);
        if (invoice.valid_until) {
            doc.text(`Valable jusqu'au : ${new Date(invoice.valid_until).toLocaleDateString('fr-FR')}`, rightX, y + 42);
        }
        const statusMap = {
            'draft': { label: 'BROUILLON', color: '#95a5a6' },
            'sent': { label: 'ENVOYÉE', color: '#3498db' },
            'accepted': { label: 'ACCEPTÉE', color: '#27ae60' },
            'rejected': { label: 'REJETÉE', color: '#e74c3c' }
        };
        const statusInfo = statusMap[invoice.status] || { label: 'INCONNU', color: '#95a5a6' };
        doc.rect(400, y + 42, 90, 20).fill(statusInfo.color);
        doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
           .text(statusInfo.label, 418, y + 48);

        y += 95;

        // ============================================================
        // TABLEAU DES PRODUITS
        // ============================================================
        const colX = {
            product: 55,
            qty: 270,
            price: 355,
            total: 460
        };
        const widthQty = 50;
        const widthPrice = 80;
        const widthTotal = 90;
        const rowH = 20;
        const headerH = 22;

        const drawTableHeader = (yPos) => {
            doc.rect(50, yPos, 500, headerH).fill('#2c6e9e');
            doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
            doc.text('DESIGNATION', colX.product, yPos + 6);
            doc.text('QTÉ', colX.qty, yPos + 6, { width: widthQty, align: 'right' });
            doc.text('PRIX UNIT.', colX.price, yPos + 6, { width: widthPrice, align: 'right' });
            doc.text('MONTANT', colX.total, yPos + 6, { width: widthTotal, align: 'right' });
            return yPos + headerH;
        };

        let currentY = drawTableHeader(y);
        let subtotal = 0;
        let rowIndex = 0;
        const maxY = 750 - 100;

        for (const item of items) {
            const description = item.description || 'Article';
            const qty = item.quantity;
            const unitPrice = parseFloat(item.unit_price);
            const totalPrice = parseFloat(item.total_price);
            subtotal += totalPrice;

            if (currentY + rowH > maxY) {
                doc.addPage();
                currentY = drawTableHeader(50);
                rowIndex = 0;
            }

            const bg = rowIndex % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, currentY, 500, rowH).fill(bg);
            doc.fillColor('#1a2a3a').fontSize(8).font('Helvetica');
            const truncated = description.length > 40 ? description.substring(0, 38) + '…' : description;
            doc.text(truncated, colX.product + 2, currentY + 4);
            doc.text(qty.toString(), colX.qty, currentY + 4, { width: widthQty, align: 'right' });
            doc.text(`${formatPDFNumber(unitPrice)} ${company.currency}`, colX.price, currentY + 4, { width: widthPrice, align: 'right' });
            doc.text(`${formatPDFNumber(totalPrice)} ${company.currency}`, colX.total, currentY + 4, { width: widthTotal, align: 'right' });

            currentY += rowH;
            rowIndex++;
        }

        doc.moveTo(50, currentY).lineTo(550, currentY).stroke('#e0e4e8');
        currentY += 10;

        // ============================================================
        // RÉSUMÉ DES TOTAUX
        // ============================================================
        const summaryX = 360;
        const taxRate = invoice.tax_rate || 0;
        const taxAmount = invoice.tax || 0;
        const remiseValue = (invoice.remise_pct || 0) / 100 * subtotal;
        const acompteValue = invoice.acompte || 0;
        const total = invoice.total || 0;

        const summaryLines = [];
        summaryLines.push({ label: 'Sous-total', value: formatPDFNumber(subtotal) });
        if (taxRate > 0) {
            summaryLines.push({ label: `TVA (${taxRate}%)`, value: formatPDFNumber(taxAmount) });
        }
        if (invoice.remise_pct && invoice.remise_pct > 0) {
            summaryLines.push({ label: `Remise (${invoice.remise_pct}%)`, value: `- ${formatPDFNumber(remiseValue)}` });
        }
        if (acompteValue > 0) {
            summaryLines.push({ label: 'Acompte', value: `- ${formatPDFNumber(acompteValue)}` });
        }

        summaryLines.forEach((line, idx) => {
            const yPos = currentY + idx * 18;
            doc.fillColor('#3a4a5a').fontSize(9).font('Helvetica');
            doc.text(line.label, summaryX, yPos, { width: 100, align: 'right' });
            doc.text(`${line.value} ${company.currency}`, 450, yPos, { width: 80, align: 'right' });
        });
        currentY += summaryLines.length * 18 + 8;

        // ============================================================
        // NET À PAYER
        // ============================================================
        doc.rect(350, currentY, 200, 28).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold');
        doc.text('NET À PAYER', 360, currentY + 8);
        doc.text(`${formatPDFNumber(total)} ${company.currency}`, 440, currentY + 8, { width: 110, align: 'right' });
        currentY += 35;

        // ============================================================
        // QR CODE (optionnel)
        // ============================================================
        // (Optionnel : décommentez si vous voulez un QR code)

        // ============================================================
        // PIED DE PAGE + CACHET + SIGNATURE
        // ============================================================
        const footerY = 750;
        const imgWidth = 100;
        const imgHeight = 40;
        const marginLeft = 50;
        const pageWidth = 500;

        // Pied de page
        doc.rect(50, footerY, 500, 25).fill('#f0f4f8');
        doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
        doc.text('Document non contractuel – Devis valant accord', 50, footerY + 8, { align: 'center' });

        // Cachet et signature
        const spaceNeeded = imgHeight + 30;
        if (hasCachet || hasSignature) {
            if (footerY - spaceNeeded < 50) {
                // Nouvelle page si besoin
                doc.addPage();
                const newFooterY = 750;
                doc.rect(50, newFooterY, 500, 25).fill('#f0f4f8');
                doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
                doc.text('Document non contractuel – Devis valant accord', 50, newFooterY + 8, { align: 'center' });

                if (hasCachet) {
                    try {
                        let imageBuffer;
                        if (userCachet.startsWith('data:image')) {
                            const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userCachet);
                        }
                        doc.image(imageBuffer, 50, newFooterY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Cachet', 50, newFooterY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) {
                        console.log('⚠️ Erreur chargement cachet proforma:', e.message);
                    }
                }
                if (hasSignature) {
                    try {
                        const sigX = 500 - imgWidth;
                        let imageBuffer;
                        if (userSignature.startsWith('data:image')) {
                            const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userSignature);
                        }
                        doc.image(imageBuffer, sigX, newFooterY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Signature', sigX, newFooterY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) {
                        console.log('⚠️ Erreur chargement signature proforma:', e.message);
                    }
                }
            } else {
                // Place disponible sur la page en cours
                if (hasCachet) {
                    try {
                        let imageBuffer;
                        if (userCachet.startsWith('data:image')) {
                            const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userCachet);
                        }
                        doc.image(imageBuffer, marginLeft, footerY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Cachet', marginLeft, footerY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) {
                        console.log('⚠️ Erreur chargement cachet proforma:', e.message);
                    }
                }
                if (hasSignature) {
                    try {
                        const sigX = pageWidth + marginLeft - imgWidth;
                        let imageBuffer;
                        if (userSignature.startsWith('data:image')) {
                            const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userSignature);
                        }
                        doc.image(imageBuffer, sigX, footerY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Signature', sigX, footerY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) {
                        console.log('⚠️ Erreur chargement signature proforma:', e.message);
                    }
                }
            }
        }

        doc.end();
        console.log(`✅ Proforma ${invoice.proforma_number} générée avec succès`);

    } catch (err) {
        console.error('Erreur génération proforma:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur génération proforma' });
        }
    }
});
// ========== PDF HEADER ==========
async function drawCompanyHeader(doc, company, startY = 45) {
    const fullWidth = 500;
    const headerHeight = 110;
    doc.rect(50, startY, fullWidth, headerHeight).fill('#ffffff');

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

    doc.fillColor('#2c3e50');
    doc.fontSize(18).font('Helvetica-Bold')
       .text(company.company_name, textStartX, startY + 10, { width: textWidth - 20, align: 'center' });

    let currentY = startY + 35;
    if (company.company_subtitle && company.company_subtitle.trim() !== '') {
        doc.fontSize(10).font('Helvetica')
           .text(company.company_subtitle, textStartX, currentY, { width: textWidth - 20, align: 'center' });
        currentY += 15;
    }
    if (company.company_activity && company.company_activity.trim() !== '') {
        doc.fontSize(9).font('Helvetica-Oblique')
           .text(company.company_activity, textStartX, currentY, { width: textWidth - 20, align: 'center' });
        currentY += 15;
    }
    if (company.company_rc && company.company_rc.trim() !== '') {
        doc.fontSize(8).font('Helvetica')
           .text(company.company_rc, textStartX, currentY, { width: textWidth - 20, align: 'center' });
        currentY += 15;
    }
    if (company.company_address && company.company_address.trim() !== '') {
        doc.fontSize(9).font('Helvetica')
           .text(company.company_address, textStartX, currentY, { width: textWidth - 20, align: 'center' });
        currentY += 15;
    }

    let phoneLine = '';
    if (company.company_phone) phoneLine += `Tél : ${company.company_phone}`;
    if (company.company_phone2) phoneLine += ` // ${company.company_phone2}`;
    if (phoneLine) {
        doc.fontSize(9).font('Helvetica')
           .text(phoneLine, textStartX, currentY, { width: textWidth - 20, align: 'center' });
    }

    doc.moveTo(50, startY + headerHeight + 5)
       .lineTo(550, startY + headerHeight + 5)
       .stroke('#cccccc');

    return startY + headerHeight + 20;
}
// ========== ROUTE FACTURE PDF ==========
app.get('/api/sales/:id/invoice', authenticate, async (req, res) => {
    console.log(`📄 Génération facture #${req.params.id} - Début`);

    try {
        const saleId = req.params.id;
        const [saleRows] = await pool.query(`
            SELECT s.*, c.name as client_name, c.email as client_email, c.address as client_address 
            FROM sales s 
            LEFT JOIN clients c ON s.client_id = c.id 
            WHERE s.id = ? AND s.user_id = ?
        `, [saleId, req.user.id]);
        if (saleRows.length === 0) {
            console.log(`❌ Vente #${saleId} non trouvée`);
            return res.status(404).json({ error: 'Vente non trouvée' });
        }
        const sale = saleRows[0];

        const [items] = await pool.query(`
            SELECT si.*, p.name as product_name 
            FROM sale_items si 
            JOIN products p ON si.product_id = p.id 
            WHERE si.sale_id = ?
        `, [saleId]);
        console.log(`📦 ${items.length} articles récupérés`);

        const [settingsRows] = await pool.query('SELECT * FROM settings WHERE user_id = ?', [req.user.id]);
        const company = settingsRows[0] || { company_name: 'Mon Entreprise', currency: 'FCFA' };

        const taxRate = sale.tax_rate !== null && sale.tax_rate !== undefined ? parseFloat(sale.tax_rate) : parseFloat(company.tax_rate || 0);

        // QR code
        const shopId = req.user.id;
        const storeUrl = `${req.protocol}://${req.get('host')}/store?shop=${shopId}`;
        let qrBuffer = null;
        try {
            qrBuffer = await QRCode.toBuffer(storeUrl, { width: 120, margin: 1 });
            console.log('✅ QR code généré');
        } catch (e) { console.error('QR error:', e); }

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=facture_${saleId}.pdf`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        doc.pipe(res);

        // ============================================================
        // EN-TÊTE
        // ============================================================
        let y = await drawCompanyHeader(doc, company);

        doc.fillColor('#2c6e9e').fontSize(18).font('Helvetica-Bold')
           .text(`FACTURE N° ${String(saleId).padStart(5, '0')}`, 50, y, { align: 'center' });
        y += 30;

        // ============================================================
        // BLOC CLIENT / DÉTAILS
        // ============================================================
        doc.rect(50, y, 500, 80).fill('#f5f7fa').stroke('#e0e4e8', 0.5);

        // --- CLIENT (gauche) ---
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('CLIENT', 60, y + 8);
        doc.fillColor('#3a4a5a').fontSize(11).font('Helvetica')
           .text(sale.client_name || 'Client particulier', 60, y + 25);

        let clientY = y + 42;
        if (sale.client_address) {
            doc.fontSize(9).font('Helvetica').text(sale.client_address, 60, clientY);
            clientY += 16;
        }
        if (sale.client_email) {
            doc.fontSize(9).font('Helvetica').text(`Email : ${sale.client_email}`, 60, clientY);
            clientY += 16;
        }

        // --- Mode de paiement (en bas de la colonne client) ---
        const paymentLabels = {
            cash: 'Espèces',
            wave: 'Wave',
            orange: 'Orange Money',
            card: 'Carte bancaire',
            transfer: 'Virement'
        };
        const method = sale.payment_method || 'cash';
        const paymentText = paymentLabels[method] || method;
        doc.fontSize(9).font('Helvetica')
           .text(`Mode de paiement : ${paymentText}`, 60, clientY);

        // --- DÉTAILS FACTURE (droite) ---
        const rightX = 350;
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('DÉTAILS FACTURE', rightX, y + 8);
        doc.fillColor('#3a4a5a').fontSize(10).font('Helvetica')
           .text(`Date : ${new Date(sale.sale_date).toLocaleDateString('fr-FR')}`, rightX, y + 25);

        // --- Statut (à droite) ---
        const statusMap = {
            'completed': { label: 'PAYÉE', color: '#27ae60' },
            'pending': { label: 'EN ATTENTE', color: '#f39c12' },
            'cancelled': { label: 'ANNULÉE', color: '#e74c3c' }
        };
        const statusInfo = statusMap[sale.status] || { label: 'INCONNU', color: '#95a5a6' };
        doc.rect(400, y + 42, 90, 20).fill(statusInfo.color);
        doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
           .text(statusInfo.label, 418, y + 48);

        y += 95;

        // ============================================================
        // TABLEAU DES PRODUITS
        // ============================================================
        const colX = {
            product: 55,
            qty: 270,
            price: 355,
            total: 460
        };
        const widthQty = 50;
        const widthPrice = 80;
        const widthTotal = 90;
        const rowH = 20;
        const headerH = 22;

        const drawTableHeader = (yPos) => {
            doc.rect(50, yPos, 500, headerH).fill('#2c6e9e');
            doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
            doc.text('PRODUIT', colX.product, yPos + 6);
            doc.text('QTÉ', colX.qty, yPos + 6, { width: widthQty, align: 'right' });
            doc.text('PRIX UNIT.', colX.price, yPos + 6, { width: widthPrice, align: 'right' });
            doc.text('TOTAL', colX.total, yPos + 6, { width: widthTotal, align: 'right' });
            return yPos + headerH;
        };

        let currentY = drawTableHeader(y);
        let subtotal = 0;
        let rowIndex = 0;
        const maxY = 750 - 100;

        for (const item of items) {
            const productName = item.product_name || 'Produit';
            const qty = item.quantity;
            const unitPrice = parseFloat(item.unit_price);
            const totalPrice = parseFloat(item.total_price);
            subtotal += totalPrice;

            if (currentY + rowH > maxY) {
                doc.addPage();
                currentY = drawTableHeader(50);
                rowIndex = 0;
            }

            const bg = rowIndex % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, currentY, 500, rowH).fill(bg);
            doc.fillColor('#1a2a3a').fontSize(8).font('Helvetica');
            const truncated = productName.length > 30 ? productName.substring(0, 28) + '…' : productName;
            doc.text(truncated, colX.product + 2, currentY + 4);
            doc.text(qty.toString(), colX.qty, currentY + 4, { width: widthQty, align: 'right' });
            doc.text(`${formatPDFNumber(unitPrice)} ${company.currency}`, colX.price, currentY + 4, { width: widthPrice, align: 'right' });
            doc.text(`${formatPDFNumber(totalPrice)} ${company.currency}`, colX.total, currentY + 4, { width: widthTotal, align: 'right' });

            currentY += rowH;
            rowIndex++;
        }

        doc.moveTo(50, currentY).lineTo(550, currentY).stroke('#e0e4e8');
        currentY += 10;

        // ============================================================
        // RÉSUMÉ ET NET À PAYER
        // ============================================================
        const summaryX = 360;
        const taxAmount = (taxRate / 100) * subtotal;
        const remiseValue = (sale.remise_pct || 0) / 100 * subtotal;
        const acompteValue = sale.acompte || 0;
        const netAPayer = subtotal - remiseValue - acompteValue;

        const summaryLines = [];
        summaryLines.push({ label: 'Sous-total', value: formatPDFNumber(subtotal) });
        if (sale.remise_pct && sale.remise_pct > 0) {
            summaryLines.push({ label: `Remise (${sale.remise_pct}%)`, value: `- ${formatPDFNumber(remiseValue)}` });
        }
        if (acompteValue > 0) {
            summaryLines.push({ label: 'Acompte', value: `- ${formatPDFNumber(acompteValue)}` });
        }

        summaryLines.forEach((line, idx) => {
            const yPos = currentY + idx * 18;
            doc.fillColor('#3a4a5a').fontSize(9).font('Helvetica');
            doc.text(line.label, summaryX, yPos, { width: 100, align: 'right' });
            doc.text(`${line.value} ${company.currency}`, 450, yPos, { width: 80, align: 'right' });
        });
        currentY += summaryLines.length * 18 + 8;

        // NET À PAYER (cadre bleu)
        doc.rect(350, currentY, 200, 28).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold');
        doc.text('NET À PAYER', 360, currentY + 8);
        doc.text(`${formatPDFNumber(netAPayer)} ${company.currency}`, 440, currentY + 8, { width: 110, align: 'right' });
        currentY += 35;

        // ============================================================
        // PIED DE PAGE : CACHET, SIGNATURE, QR CODE
        // ============================================================
        console.log('📄 Génération du bas de page...');

        const footerY = 750;
        const cachetWidth = 120;
        const cachetHeight = 50;
        const signatureWidth = 120;
        const signatureHeight = 50;
        const qrSize = 60;
        const marginLeft = 50;
        const pageWidth = 500;

        const cachetX = marginLeft;
        const signatureX = marginLeft + cachetWidth + 30;
        const qrX = pageWidth + marginLeft - qrSize - 10;

        doc.rect(50, footerY, 500, 25).fill('#f0f4f8');
        doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
        doc.text('Merci de votre confiance • Facture générée par GestPro', 50, footerY + 8, { align: 'center' });

        const [userSettings] = await pool.query(
            'SELECT cachet_url, signature_url FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const userCachet = userSettings[0]?.cachet_url || null;
        const userSignature = userSettings[0]?.signature_url || null;
        const hasCachet = userCachet && userCachet.trim() !== '';
        const hasSignature = userSignature && userSignature.trim() !== '';

        if (hasCachet) {
            try {
                let imageBuffer;
                if (userCachet.startsWith('data:image')) {
                    const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                    imageBuffer = Buffer.from(base64Data, 'base64');
                } else {
                    imageBuffer = await fetchImage(userCachet);
                }
                const yPos = footerY - cachetHeight - 8;
                doc.image(imageBuffer, cachetX, yPos, { width: cachetWidth, height: cachetHeight });
                doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                   .text('Cachet', cachetX, footerY - 3, { width: cachetWidth, align: 'center' });
            } catch (e) {
                console.log('⚠️ Erreur chargement cachet:', e.message);
            }
        }

        if (hasSignature) {
            try {
                let imageBuffer;
                if (userSignature.startsWith('data:image')) {
                    const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                    imageBuffer = Buffer.from(base64Data, 'base64');
                } else {
                    imageBuffer = await fetchImage(userSignature);
                }
                const yPos = footerY - signatureHeight - 8;
                doc.image(imageBuffer, signatureX, yPos, { width: signatureWidth, height: signatureHeight });
                doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                   .text('Signature', signatureX, footerY - 3, { width: signatureWidth, align: 'center' });
            } catch (e) {
                console.log('⚠️ Erreur chargement signature:', e.message);
            }
        }

        if (qrBuffer) {
            const qrY = footerY - qrSize - 8;
            doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
            doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
               .text('Scannez', qrX, footerY - 3, { width: qrSize, align: 'center' });
        }

        console.log(`✅ Facture #${saleId} générée avec succès`);
        doc.end();

    } catch (err) {
        console.error(`❌ Erreur facture #${req.params.id}:`, err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur génération facture' });
        }
    }
});
// ========== ROUTE BON DE COMMANDE (VERSION COMPLÈTE ET LISIBLE) ==========
app.get('/api/sales/:id/order', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;

        // Récupérer la vente
        const [saleRows] = await pool.query(`
            SELECT s.*, c.name as client_name, c.email as client_email, c.address as client_address
            FROM sales s
            LEFT JOIN clients c ON s.client_id = c.id
            WHERE s.id = ? AND s.user_id = ?
        `, [saleId, req.user.id]);

        if (saleRows.length === 0) {
            return res.status(404).json({ error: 'Vente non trouvée' });
        }
        const sale = saleRows[0];

        // Récupérer les articles
        const [items] = await pool.query(`
            SELECT si.*, p.name as product_name
            FROM sale_items si
            JOIN products p ON si.product_id = p.id
            WHERE si.sale_id = ?
        `, [saleId]);

        // Récupérer les paramètres société
        const [settingsRows] = await pool.query(
            'SELECT * FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const company = settingsRows[0] || {
            company_name: 'Mon Entreprise',
            currency: 'FCFA'
        };

        // Récupérer cachet et signature
        const [userSettings] = await pool.query(
            'SELECT cachet_url, signature_url FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const userCachet = userSettings[0]?.cachet_url || null;
        const userSignature = userSettings[0]?.signature_url || null;
        const hasCachet = userCachet && userCachet.trim() !== '';
        const hasSignature = userSignature && userSignature.trim() !== '';

        // Créer le document PDF
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=bon_commande_${saleId}.pdf`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        doc.pipe(res);

        // Fonction d'en-tête locale
        async function drawCompanyHeaderLocal(doc, company, startY = 45) {
            const fullWidth = 500;
            const headerHeight = 110;
            doc.rect(50, startY, fullWidth, headerHeight).fill('#ffffff');

            let textStartX = 50;
            let textWidth = 500;

            if (company.logo_url && company.logo_url.trim() !== '') {
                try {
                    const logoBuffer = await fetchImage(company.logo_url);
                    doc.image(logoBuffer, 50, startY + 5, { width: 80 });
                    textStartX = 150;
                    textWidth = 400;
                } catch(e) { /* ignorer */ }
            }

            doc.fillColor('#2c3e50');
            doc.fontSize(18).font('Helvetica-Bold')
               .text(company.company_name, textStartX, startY + 10, { width: textWidth - 20, align: 'center' });

            let currentY = startY + 35;
            if (company.company_subtitle && company.company_subtitle.trim() !== '') {
                doc.fontSize(10).font('Helvetica')
                   .text(company.company_subtitle, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_activity && company.company_activity.trim() !== '') {
                doc.fontSize(9).font('Helvetica-Oblique')
                   .text(company.company_activity, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_rc && company.company_rc.trim() !== '') {
                doc.fontSize(8).font('Helvetica')
                   .text(company.company_rc, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_address && company.company_address.trim() !== '') {
                doc.fontSize(9).font('Helvetica')
                   .text(company.company_address, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }

            let phoneLine = '';
            if (company.company_phone) phoneLine += `Tél : ${company.company_phone}`;
            if (company.company_phone2) phoneLine += ` // ${company.company_phone2}`;
            if (phoneLine) {
                doc.fontSize(9).font('Helvetica')
                   .text(phoneLine, textStartX, currentY, { width: textWidth - 20, align: 'center' });
            }

            doc.moveTo(50, startY + headerHeight + 5)
               .lineTo(550, startY + headerHeight + 5)
               .stroke('#cccccc');

            return startY + headerHeight + 20;
        }

        // En-tête
        let y = await drawCompanyHeaderLocal(doc, company);

        // Titre
        doc.fillColor('#2c6e9e').fontSize(18).font('Helvetica-Bold')
           .text(`BON DE COMMANDE N° ${String(saleId).padStart(5, '0')}`, 50, y, { align: 'center' });
        y += 30;

        // Bloc client / détails
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
           .text('DÉTAILS COMMANDE', rightX, y + 8);
        doc.fillColor('#3a4a5a').fontSize(10).font('Helvetica')
           .text(`Date : ${new Date(sale.sale_date).toLocaleDateString('fr-FR')}`, rightX, y + 25);
        if (sale.due_date) {
            doc.text(`Échéance : ${new Date(sale.due_date).toLocaleDateString('fr-FR')}`, rightX, y + 42);
        }
        const statusMap = {
            'completed': { label: 'TERMINÉE', color: '#27ae60' },
            'pending': { label: 'EN ATTENTE', color: '#f39c12' },
            'cancelled': { label: 'ANNULÉE', color: '#e74c3c' }
        };
        const statusInfo = statusMap[sale.status] || { label: 'INCONNU', color: '#95a5a6' };
        doc.rect(400, y + 42, 90, 20).fill(statusInfo.color);
        doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
           .text(statusInfo.label, 418, y + 48);

        y += 85;

        // Tableau des produits
        const colX = { product: 55, qty: 270, price: 355, total: 460 };
        const widthQty = 50, widthPrice = 80, widthTotal = 90;
        const rowH = 20, headerH = 22;
        const drawTableHeader = (yPos) => {
            doc.rect(50, yPos, 500, headerH).fill('#2c6e9e');
            doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
            doc.text('PRODUIT', colX.product, yPos + 6);
            doc.text('QTÉ', colX.qty, yPos + 6, { width: widthQty, align: 'right' });
            doc.text('PRIX UNIT.', colX.price, yPos + 6, { width: widthPrice, align: 'right' });
            doc.text('TOTAL', colX.total, yPos + 6, { width: widthTotal, align: 'right' });
            return yPos + headerH;
        };

        let currentY = drawTableHeader(y);
        let subtotal = 0;
        let rowIndex = 0;
        const maxY = 750 - 100;

        for (const item of items) {
            const productName = item.product_name || 'Produit';
            const qty = item.quantity;
            const unitPrice = parseFloat(item.unit_price);
            const totalPrice = parseFloat(item.total_price);
            subtotal += totalPrice;

            if (currentY + rowH > maxY) {
                doc.addPage();
                currentY = drawTableHeader(50);
                rowIndex = 0;
            }

            const bg = rowIndex % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, currentY, 500, rowH).fill(bg);
            doc.fillColor('#1a2a3a').fontSize(8).font('Helvetica');
            const truncated = productName.length > 30 ? productName.substring(0, 28) + '…' : productName;
            doc.text(truncated, colX.product + 2, currentY + 4);
            doc.text(qty.toString(), colX.qty, currentY + 4, { width: widthQty, align: 'right' });
            doc.text(`${formatPDFNumber(unitPrice)} ${company.currency}`, colX.price, currentY + 4, { width: widthPrice, align: 'right' });
            doc.text(`${formatPDFNumber(totalPrice)} ${company.currency}`, colX.total, currentY + 4, { width: widthTotal, align: 'right' });

            currentY += rowH;
            rowIndex++;
        }

        doc.moveTo(50, currentY).lineTo(550, currentY).stroke('#e0e4e8');
        currentY += 10;

        // Résumé
        const summaryX = 360;
        const taxRate = sale.tax_rate || 0;
        const taxAmount = sale.tax || 0;
        const remiseValue = (sale.remise_pct || 0) / 100 * subtotal;
        const acompteValue = sale.acompte || 0;
        const finalAmount = sale.final_amount || 0;

        const summaryLines = [];
        summaryLines.push({ label: 'Sous-total', value: formatPDFNumber(subtotal) });
        if (taxRate > 0) {
            summaryLines.push({ label: `TVA (${taxRate}%)`, value: formatPDFNumber(taxAmount) });
        }
        if (sale.remise_pct && sale.remise_pct > 0) {
            summaryLines.push({ label: `Remise (${sale.remise_pct}%)`, value: `- ${formatPDFNumber(remiseValue)}` });
        }
        if (acompteValue > 0) {
            summaryLines.push({ label: 'Acompte', value: `- ${formatPDFNumber(acompteValue)}` });
        }

        summaryLines.forEach((line, idx) => {
            const yPos = currentY + idx * 18;
            doc.fillColor('#3a4a5a').fontSize(9).font('Helvetica');
            doc.text(line.label, summaryX, yPos, { width: 100, align: 'right' });
            doc.text(`${line.value} ${company.currency}`, 450, yPos, { width: 80, align: 'right' });
        });
        currentY += summaryLines.length * 18 + 8;

        // Net à payer
        doc.rect(350, currentY, 200, 28).fill('#2c6e9e');
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold');
        doc.text('NET À PAYER', 360, currentY + 8);
        doc.text(`${formatPDFNumber(finalAmount)} ${company.currency}`, 440, currentY + 8, { width: 110, align: 'right' });
        currentY += 35;

        // Pied de page + cachet + signature
        const footerY = 750;
        const imgWidth = 100, imgHeight = 40, marginLeft = 50, pageWidth = 500;

        doc.rect(50, footerY, 500, 25).fill('#f0f4f8');
        doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
        doc.text('Merci de votre commande', 50, footerY + 8, { align: 'center' });

        const spaceNeeded = imgHeight + 30;
        if (hasCachet || hasSignature) {
            if (footerY - spaceNeeded < 50) {
                doc.addPage();
                const newFooterY = 750;
                doc.rect(50, newFooterY, 500, 25).fill('#f0f4f8');
                doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
                doc.text('Merci de votre commande', 50, newFooterY + 8, { align: 'center' });

                if (hasCachet) {
                    try {
                        let imageBuffer;
                        if (userCachet.startsWith('data:image')) {
                            const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userCachet);
                        }
                        doc.image(imageBuffer, 50, newFooterY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Cachet', 50, newFooterY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur cachet:', e.message); }
                }
                if (hasSignature) {
                    try {
                        const sigX = 500 - imgWidth;
                        let imageBuffer;
                        if (userSignature.startsWith('data:image')) {
                            const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userSignature);
                        }
                        doc.image(imageBuffer, sigX, newFooterY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Signature', sigX, newFooterY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur signature:', e.message); }
                }
            } else {
                if (hasCachet) {
                    try {
                        let imageBuffer;
                        if (userCachet.startsWith('data:image')) {
                            const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userCachet);
                        }
                        doc.image(imageBuffer, marginLeft, footerY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Cachet', marginLeft, footerY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur cachet:', e.message); }
                }
                if (hasSignature) {
                    try {
                        const sigX = pageWidth + marginLeft - imgWidth;
                        let imageBuffer;
                        if (userSignature.startsWith('data:image')) {
                            const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userSignature);
                        }
                        doc.image(imageBuffer, sigX, footerY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Signature', sigX, footerY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur signature:', e.message); }
                }
            }
        }

        doc.end();
        console.log(`✅ Bon de commande #${saleId} généré avec succès`);

    } catch (err) {
        console.error('Erreur bon de commande:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur génération bon de commande' });
        }
    }
});
// ========== ROUTE BORDEREAU DE LIVRAISON (VERSION COMPLÈTE) ==========
app.get('/api/sales/:id/delivery', authenticate, async (req, res) => {
    try {
        const saleId = req.params.id;

        // Récupérer la vente
        const [saleRows] = await pool.query(`
            SELECT s.*, c.name as client_name, c.address as client_address
            FROM sales s
            LEFT JOIN clients c ON s.client_id = c.id
            WHERE s.id = ? AND s.user_id = ?
        `, [saleId, req.user.id]);

        if (saleRows.length === 0) {
            return res.status(404).json({ error: 'Vente non trouvée' });
        }
        const sale = saleRows[0];

        // Récupérer les articles
        const [items] = await pool.query(`
            SELECT si.*, p.name as product_name
            FROM sale_items si
            JOIN products p ON si.product_id = p.id
            WHERE si.sale_id = ?
        `, [saleId]);

        // Paramètres société
        const [settingsRows] = await pool.query(
            'SELECT * FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const company = settingsRows[0] || {
            company_name: 'Mon Entreprise',
            currency: 'FCFA'
        };

        // Cachet et signature
        const [userSettings] = await pool.query(
            'SELECT cachet_url, signature_url FROM settings WHERE user_id = ?',
            [req.user.id]
        );
        const userCachet = userSettings[0]?.cachet_url || null;
        const userSignature = userSettings[0]?.signature_url || null;
        const hasCachet = userCachet && userCachet.trim() !== '';
        const hasSignature = userSignature && userSignature.trim() !== '';

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=bordereau_livraison_${saleId}.pdf`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        doc.pipe(res);

        // Fonction en-tête locale (identique aux précédentes)
        async function drawCompanyHeaderLocal(doc, company, startY = 45) {
            const fullWidth = 500;
            const headerHeight = 110;
            doc.rect(50, startY, fullWidth, headerHeight).fill('#ffffff');

            let textStartX = 50;
            let textWidth = 500;

            if (company.logo_url && company.logo_url.trim() !== '') {
                try {
                    const logoBuffer = await fetchImage(company.logo_url);
                    doc.image(logoBuffer, 50, startY + 5, { width: 80 });
                    textStartX = 150;
                    textWidth = 400;
                } catch(e) { /* ignorer */ }
            }

            doc.fillColor('#2c3e50');
            doc.fontSize(18).font('Helvetica-Bold')
               .text(company.company_name, textStartX, startY + 10, { width: textWidth - 20, align: 'center' });

            let currentY = startY + 35;
            if (company.company_subtitle && company.company_subtitle.trim() !== '') {
                doc.fontSize(10).font('Helvetica')
                   .text(company.company_subtitle, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_activity && company.company_activity.trim() !== '') {
                doc.fontSize(9).font('Helvetica-Oblique')
                   .text(company.company_activity, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_rc && company.company_rc.trim() !== '') {
                doc.fontSize(8).font('Helvetica')
                   .text(company.company_rc, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }
            if (company.company_address && company.company_address.trim() !== '') {
                doc.fontSize(9).font('Helvetica')
                   .text(company.company_address, textStartX, currentY, { width: textWidth - 20, align: 'center' });
                currentY += 15;
            }

            let phoneLine = '';
            if (company.company_phone) phoneLine += `Tél : ${company.company_phone}`;
            if (company.company_phone2) phoneLine += ` // ${company.company_phone2}`;
            if (phoneLine) {
                doc.fontSize(9).font('Helvetica')
                   .text(phoneLine, textStartX, currentY, { width: textWidth - 20, align: 'center' });
            }

            doc.moveTo(50, startY + headerHeight + 5)
               .lineTo(550, startY + headerHeight + 5)
               .stroke('#cccccc');

            return startY + headerHeight + 20;
        }

        let y = await drawCompanyHeaderLocal(doc, company);

        // Titre
        doc.fillColor('#2c6e9e').fontSize(18).font('Helvetica-Bold')
           .text(`BORDEREAU DE LIVRAISON N° ${String(saleId).padStart(5, '0')}`, 50, y, { align: 'center' });
        y += 30;

        // Bloc client
        doc.rect(50, y, 500, 70).fill('#f5f7fa').stroke('#e0e4e8', 0.5);
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('CLIENT', 60, y + 8);
        doc.fillColor('#3a4a5a').fontSize(11).font('Helvetica')
           .text(sale.client_name || 'Client particulier', 60, y + 25);
        if (sale.client_address) {
            doc.fontSize(9).font('Helvetica').text(`Adresse : ${sale.client_address}`, 60, y + 42);
        }

        const rightX = 350;
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica-Bold')
           .text('DÉTAILS LIVRAISON', rightX, y + 8);
        doc.fillColor('#3a4a5a').fontSize(10).font('Helvetica')
           .text(`Date commande : ${new Date(sale.sale_date).toLocaleDateString('fr-FR')}`, rightX, y + 25);
        if (sale.due_date) {
            doc.text(`Livraison souhaitée : ${new Date(sale.due_date).toLocaleDateString('fr-FR')}`, rightX, y + 42);
        }
        doc.rect(400, y + 42, 90, 20).fill('#3498db');
        doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
           .text('À LIVRER', 418, y + 48);

        y += 85;

        // Tableau des produits (colonne "Remarque" vide)
        const colX = { product: 55, qty: 270, remark: 355 };
        const rowH = 20, headerH = 22;
        const drawTableHeader = (yPos) => {
            doc.rect(50, yPos, 500, headerH).fill('#2c6e9e');
            doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
            doc.text('PRODUIT', colX.product, yPos + 6);
            doc.text('QTÉ', colX.qty, yPos + 6, { width: 50, align: 'right' });
            doc.text('REMARQUE', colX.remark, yPos + 6, { width: 130, align: 'left' });
            return yPos + headerH;
        };

        let currentY = drawTableHeader(y);
        let rowIndex = 0;
        const maxY = 750 - 100;

        for (const item of items) {
            const productName = item.product_name || 'Produit';
            const qty = item.quantity;

            if (currentY + rowH > maxY) {
                doc.addPage();
                currentY = drawTableHeader(50);
                rowIndex = 0;
            }

            const bg = rowIndex % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, currentY, 500, rowH).fill(bg);
            doc.fillColor('#1a2a3a').fontSize(8).font('Helvetica');
            const truncated = productName.length > 30 ? productName.substring(0, 28) + '…' : productName;
            doc.text(truncated, colX.product + 2, currentY + 4);
            doc.text(qty.toString(), colX.qty, currentY + 4, { width: 50, align: 'right' });
            doc.text('', colX.remark, currentY + 4, { width: 130, align: 'left' });

            currentY += rowH;
            rowIndex++;
        }

        // Ligne séparatrice
        doc.moveTo(50, currentY).lineTo(550, currentY).stroke('#e0e4e8');
        currentY += 20;

        // Zones de signature
        doc.fillColor('#1a2a3a').fontSize(10).font('Helvetica');
        doc.text('Date de livraison : _________________________________', 60, currentY);
        doc.text('Signature du client : _________________________________', 60, currentY + 20);

        currentY += 50;

        // Pied de page + cachet + signature
        const footerY = 750;
        const imgWidth = 100, imgHeight = 40, marginLeft = 50, pageWidth = 500;

        doc.rect(50, footerY, 500, 25).fill('#f0f4f8');
        doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
        doc.text('Bon de livraison à conserver', 50, footerY + 8, { align: 'center' });

        const spaceNeeded = imgHeight + 30;
        if (hasCachet || hasSignature) {
            if (footerY - spaceNeeded < 50) {
                doc.addPage();
                const newFooterY = 750;
                doc.rect(50, newFooterY, 500, 25).fill('#f0f4f8');
                doc.fillColor('#7a8a9a').fontSize(8).font('Helvetica');
                doc.text('Bon de livraison à conserver', 50, newFooterY + 8, { align: 'center' });

                if (hasCachet) {
                    try {
                        let imageBuffer;
                        if (userCachet.startsWith('data:image')) {
                            const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userCachet);
                        }
                        doc.image(imageBuffer, 50, newFooterY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Cachet', 50, newFooterY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur cachet:', e.message); }
                }
                if (hasSignature) {
                    try {
                        const sigX = 500 - imgWidth;
                        let imageBuffer;
                        if (userSignature.startsWith('data:image')) {
                            const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userSignature);
                        }
                        doc.image(imageBuffer, sigX, newFooterY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Signature', sigX, newFooterY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur signature:', e.message); }
                }
            } else {
                if (hasCachet) {
                    try {
                        let imageBuffer;
                        if (userCachet.startsWith('data:image')) {
                            const base64Data = userCachet.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userCachet);
                        }
                        doc.image(imageBuffer, marginLeft, footerY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Cachet', marginLeft, footerY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur cachet:', e.message); }
                }
                if (hasSignature) {
                    try {
                        const sigX = pageWidth + marginLeft - imgWidth;
                        let imageBuffer;
                        if (userSignature.startsWith('data:image')) {
                            const base64Data = userSignature.replace(/^data:image\/\w+;base64,/, '');
                            imageBuffer = Buffer.from(base64Data, 'base64');
                        } else {
                            imageBuffer = await fetchImage(userSignature);
                        }
                        doc.image(imageBuffer, sigX, footerY - imgHeight - 8, { width: imgWidth, height: imgHeight });
                        doc.fillColor('#7a8a9a').fontSize(6).font('Helvetica')
                           .text('Signature', sigX, footerY - 3, { width: imgWidth, align: 'center' });
                    } catch (e) { console.log('⚠️ Erreur signature:', e.message); }
                }
            }
        }

        doc.end();
        console.log(`✅ Bordereau de livraison #${saleId} généré avec succès`);

    } catch (err) {
        console.error('Erreur bordereau livraison:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur génération bordereau de livraison' });
        }
    }
});

// ========== ROUTES ADMIN ORDERS ==========
app.get('/api/admin/orders', authenticate, async (req, res) => {
    const userId = req.user.id;
    console.log('🔍 Récupération des commandes pour user_id:', userId);
    try {
        const [rows] = await pool.query(
            `SELECT o.*, 
                    (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as items_count
             FROM orders o
             WHERE o.user_id = ?
             ORDER BY o.created_at DESC`,
            [userId]
        );
        console.log('📦 Commandes trouvées:', rows.length);
        res.json(rows);
    } catch (err) {
        console.error('Erreur GET /admin/orders:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders/:id', authenticate, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.id;
    try {
        const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, userId]);
        if (!orderRows.length) return res.status(404).json({ error: 'Commande non trouvée' });
        const [items] = await pool.query(
            `SELECT oi.*, p.name as product_name
             FROM order_items oi
             JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = ?`,
            [orderId]
        );
        res.json({ order: orderRows[0], items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/status', authenticate, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.id;
    const { status } = req.body;
    const validStatus = ['pending','confirmed','shipped','delivered','cancelled'];
    if (!validStatus.includes(status)) {
        return res.status(400).json({ error: 'Statut invalide' });
    }
    try {
        const [check] = await pool.query('SELECT id FROM orders WHERE id = ? AND user_id = ?', [orderId, userId]);
        if (!check.length) return res.status(403).json({ error: 'Accès non autorisé' });
        await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, orderId]);
        res.json({ message: 'Statut mis à jour' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/orders/:id/validate', authenticate, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.id;
    const { deferred_payment = false, due_date = null } = req.body;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [orderRows] = await connection.query(
            'SELECT * FROM orders WHERE id = ? AND user_id = ? AND status = ?',
            [orderId, userId, 'pending']
        );
        if (!orderRows.length) {
            return res.status(404).json({ error: 'Commande non trouvée ou déjà traitée' });
        }
        const order = orderRows[0];

        const [items] = await connection.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
        if (!items.length) {
            return res.status(400).json({ error: 'Commande sans articles' });
        }

        let clientId = null;
        if (order.customer_name) {
            let [existing] = await connection.query(
                'SELECT id FROM clients WHERE user_id = ? AND name = ?',
                [userId, order.customer_name]
            );
            if (existing.length) {
                clientId = existing[0].id;
            } else {
                const [result] = await connection.query(
                    `INSERT INTO clients (user_id, name, email, phone, address)
                     VALUES (?, ?, ?, ?, ?)`,
                    [userId, order.customer_name, order.customer_email || null,
                     order.customer_phone || null, order.customer_address || null]
                );
                clientId = result.insertId;
            }
        }

        let subtotal = 0;
        for (const item of items) {
            subtotal += parseFloat(item.total_price) || 0;
        }

        const [settings] = await connection.query('SELECT tax_rate FROM settings WHERE user_id = ?', [userId]);
        const taxRate = parseFloat(settings[0]?.tax_rate) || 0;
        const tax = subtotal * (taxRate / 100);
        let finalAmount = subtotal + tax;

        if (isNaN(finalAmount) || !isFinite(finalAmount) || finalAmount < 0) {
            finalAmount = 0;
        }
        if (finalAmount > 999999999999) {
            finalAmount = 999999999999;
        }

        const saleStatus = deferred_payment ? 'pending' : 'completed';
        let finalDueDate = null;
        if (deferred_payment) {
            finalDueDate = due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        }

        const [saleResult] = await connection.query(
            `INSERT INTO sales 
             (user_id, client_id, total_amount, tax, final_amount, payment_method, status, notes, tax_rate, due_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, clientId, subtotal, tax, finalAmount, order.payment_method || 'cash',
             saleStatus, `Commande en ligne #${orderId}`, taxRate, finalDueDate]
        );
        const saleId = saleResult.insertId;

        for (const item of items) {
            await connection.query(
                `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price)
                 VALUES (?, ?, ?, ?, ?)`,
                [saleId, item.product_id, item.quantity, item.unit_price, item.total_price]
            );
            await connection.query(
                'UPDATE products SET quantity = quantity - ? WHERE id = ? AND user_id = ?',
                [item.quantity, item.product_id, userId]
            );
            const [prodBefore] = await connection.query(
                'SELECT quantity FROM products WHERE id = ? AND user_id = ? FOR UPDATE',
                [item.product_id, userId]
            );
            const newQty = prodBefore[0].quantity - item.quantity;
            await connection.query(
                `INSERT INTO stock_movements (product_id, user_id, type, quantity_change, quantity_before, quantity_after, reference, notes)
                 VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)`,
                [item.product_id, userId, -item.quantity, prodBefore[0].quantity, newQty,
                 `VENTE #${saleId}`, `Commande en ligne #${orderId}`]
            );
        }

        if (!deferred_payment) {
            await connection.query(
                'INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, ?)',
                [saleId, finalAmount, order.payment_method || 'cash']
            );
            await connection.query(
                `INSERT INTO cash_register (user_id, transaction_type, amount, description, reference_id) 
                 VALUES (?, 'sale', ?, ?, ?)`,
                [userId, finalAmount, `Vente #${saleId} (commande en ligne)`, saleId]
            );
        }

        await connection.query(
            'UPDATE orders SET status = ?, sale_id = ? WHERE id = ?',
            ['confirmed', saleId, orderId]
        );

        await connection.commit();

        const token = req.header('Authorization')?.replace('Bearer ', '') || req.query.token;
        res.json({
            message: 'Commande validée avec succès',
            sale_id: saleId,
            status: saleStatus,
            invoice_url: `/api/sales/${saleId}/invoice?token=${token}`
        });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur validation commande:', err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.put('/api/admin/orders/:id/items', authenticate, async (req, res) => {
    const orderId = req.params.id;
    const userId = req.user.id;
    const { items } = req.body;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [orderRows] = await connection.query(
            'SELECT * FROM orders WHERE id = ? AND user_id = ? AND status = ?',
            [orderId, userId, 'pending']
        );
        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Commande non trouvée ou déjà traitée' });
        }

        await connection.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);

        let total = 0;
        for (const item of items) {
            if (!item.product_id || !item.quantity || !item.unit_price) {
                throw new Error('Données invalides');
            }
            const total_price = item.quantity * item.unit_price;
            await connection.query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
                 VALUES (?, ?, ?, ?, ?)`,
                [orderId, item.product_id, item.quantity, item.unit_price, total_price]
            );
            total += total_price;
        }

        await connection.query('UPDATE orders SET total_amount = ? WHERE id = ?', [total, orderId]);

        await connection.commit();
        res.json({ message: 'Commande modifiée avec succès', total });
    } catch (err) {
        await connection.rollback();
        console.error('Erreur modification commande:', err);
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.get('/api/admin/orders/pending-count', authenticate, async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    try {
        let query = 'SELECT COUNT(*) as count FROM orders WHERE status = ?';
        const params = ['pending'];
        if (!isAdmin) {
            query += ' AND user_id = ?';
            params.push(req.user.id);
        }
        const [rows] = await pool.query(query, params);
        res.json({ count: rows[0].count || 0 });
    } catch (err) {
        console.error('Erreur comptage commandes:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTES SOUS-COMPTES ==========
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

app.get('/api/sub-users/:id/permissions', authenticate, async (req, res) => {
    try {
        const [check] = await pool.query('SELECT id FROM sub_users WHERE id = ? AND parent_id = ?', [req.params.id, req.user.id]);
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

app.post('/api/sub-users', authenticate, async (req, res) => {
    const { name, email, password, permissions = [] } = req.body;

    if (!name || !email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Tous les champs sont requis (mot de passe min 6)' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT id FROM users WHERE email = ? UNION SELECT id FROM sub_users WHERE email = ?', [email, email]);
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

        if (permissions.length > 0) {
            const values = permissions.map(p => [subUserId, p]);
            await connection.query('INSERT INTO sub_user_permissions (sub_user_id, permission_id) VALUES ?', [values]);
        }

        await connection.query(
            `INSERT INTO sub_user_audit (sub_user_id, action, details) 
             VALUES (?, 'created', ?)`,
            [subUserId, JSON.stringify({ name, email, permissions })]
        );

        await connection.commit();
        res.status(201).json({ id: subUserId, message: 'Sous-compte créé avec succès' });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur POST /sub-users:', err);
        res.status(500).json({ error: 'Erreur lors de la création du sous-compte' });
    } finally {
        connection.release();
    }
});

app.put('/api/sub-users/:id', authenticate, async (req, res) => {
    const { name, email, is_active, permissions = [] } = req.body;
    const subUserId = req.params.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [check] = await connection.query('SELECT id FROM sub_users WHERE id = ? AND parent_id = ?', [subUserId, req.user.id]);
        if (check.length === 0) {
            return res.status(403).json({ error: 'Accès non autorisé' });
        }

        await connection.query(
            `UPDATE sub_users SET name = ?, email = ?, is_active = ? 
             WHERE id = ? AND parent_id = ?`,
            [name, email, is_active === undefined ? true : is_active, subUserId, req.user.id]
        );

        await connection.query('DELETE FROM sub_user_permissions WHERE sub_user_id = ?', [subUserId]);

        if (permissions.length > 0) {
            const values = permissions.map(p => [subUserId, p]);
            await connection.query('INSERT INTO sub_user_permissions (sub_user_id, permission_id) VALUES ?', [values]);
        }

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

app.delete('/api/sub-users/:id', authenticate, async (req, res) => {
    const subUserId = req.params.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [check] = await connection.query('SELECT id, name, email FROM sub_users WHERE id = ? AND parent_id = ?', [subUserId, req.user.id]);
        if (check.length === 0) {
            return res.status(403).json({ error: 'Accès non autorisé' });
        }

        await connection.query(
            `INSERT INTO sub_user_audit (sub_user_id, action, details) 
             VALUES (?, 'deleted', ?)`,
            [subUserId, JSON.stringify(check[0])]
        );

        await connection.query('DELETE FROM sub_users WHERE id = ? AND parent_id = ?', [subUserId, req.user.id]);

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

        const [permissions] = await pool.query(
            `SELECT p.name 
             FROM sub_user_permissions sp 
             JOIN permissions p ON sp.permission_id = p.id 
             WHERE sp.sub_user_id = ?`,
            [subUser.id]
        );

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

app.get('/api/permissions', authenticate, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, name, description FROM permissions ORDER BY name');
        res.json(rows);
    } catch (err) {
        console.error('❌ Erreur GET /permissions:', err);
        res.status(500).json({ error: 'Erreur lors du chargement des permissions' });
    }
});

// ========== MIDDLEWARE CHECK PERMISSION ==========
const checkPermission = (permissionName) => {
    return async (req, res, next) => {
        try {
            if (req.user && req.user.role === 'admin') {
                return next();
            }
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

// ========== ROUTES CLIENTS DÉTAILS ET OPÉRATIONS ==========
app.get('/api/clients/:id/details', authenticate, async (req, res) => {
    const clientId = req.params.id;
    try {
        const [client] = await pool.query('SELECT * FROM clients WHERE id = ? AND user_id = ?', [clientId, req.user.id]);
        if (client.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        const [sales] = await pool.query(
            `SELECT s.*, 
                    (SELECT COUNT(*) FROM payments WHERE sale_id = s.id) as payment_count,
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE sale_id = s.id) as total_paid
             FROM sales s 
             WHERE s.client_id = ? AND s.user_id = ?
             ORDER BY s.sale_date DESC LIMIT 50`,
            [clientId, req.user.id]
        );

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

app.get('/api/clients/:id/operations', authenticate, async (req, res) => {
    const clientId = req.params.id;
    try {
        const [clientCheck] = await pool.query('SELECT id FROM clients WHERE id = ? AND user_id = ?', [clientId, req.user.id]);
        if (clientCheck.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        const [operations] = await pool.query(
            `SELECT * FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')
             ORDER BY created_at DESC`,
            [req.user.id, clientId]
        );

        const [balance] = await pool.query(
            `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'deposit' OR transaction_type = 'payment' THEN amount ELSE -amount END), 0) as balance
             FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')`,
            [req.user.id, clientId]
        );

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

app.post('/api/clients/:id/deposit', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { amount, description, payment_method = 'cash' } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Montant invalide' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [client] = await connection.query('SELECT id, name FROM clients WHERE id = ? AND user_id = ?', [clientId, req.user.id]);
        if (client.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        await connection.query(
            `INSERT INTO cash_register 
             (user_id, transaction_type, amount, description, reference_id) 
             VALUES (?, 'deposit', ?, ?, ?)`,
            [req.user.id, amount, description || `Dépôt de ${client[0].name}`, clientId]
        );

        await connection.commit();
        res.status(201).json({ message: '✅ Dépôt enregistré', client: client[0].name, amount: amount });
    } catch (err) {
        await connection.rollback();
        console.error('❌ Erreur POST /clients/:id/deposit:', err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.post('/api/clients/:id/withdrawal', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Montant invalide' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [client] = await connection.query('SELECT id, name FROM clients WHERE id = ? AND user_id = ?', [clientId, req.user.id]);
        if (client.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        const [balance] = await connection.query(
            `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'deposit' OR transaction_type = 'payment' THEN amount ELSE -amount END), 0) as balance
             FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')`,
            [req.user.id, clientId]
        );

        if (balance[0].balance < amount) {
            return res.status(400).json({ error: `Solde insuffisant (${balance[0].balance} FCFA disponible)` });
        }

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

app.post('/api/clients/:id/pay-invoice', authenticate, async (req, res) => {
    const clientId = req.params.id;
    const { sale_id } = req.body;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [sale] = await connection.query('SELECT * FROM sales WHERE id = ? AND client_id = ? AND status = "pending"', [sale_id, clientId]);
        if (sale.length === 0) {
            return res.status(404).json({ error: 'Facture non trouvée ou déjà payée' });
        }

        const amount = sale[0].final_amount;

        const [balance] = await connection.query(
            `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'deposit' OR transaction_type = 'payment' THEN amount ELSE -amount END), 0) as balance
             FROM cash_register 
             WHERE user_id = ? AND reference_id = ? 
               AND transaction_type IN ('deposit', 'withdrawal', 'payment')`,
            [req.user.id, clientId]
        );

        if (balance[0].balance < amount) {
            return res.status(400).json({ error: `Solde insuffisant (${balance[0].balance} FCFA disponible)` });
        }

        await connection.query('INSERT INTO payments (sale_id, amount, payment_method) VALUES (?, ?, "client_account")', [sale_id, amount]);
        await connection.query('UPDATE sales SET status = "completed" WHERE id = ?', [sale_id]);
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
// ========== RAPPORT : TOTAUX PAR MODE DE PAIEMENT ==========
app.get('/api/reports/daily-payments', authenticate, async (req, res) => {
    const userId = req.user.id;
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0]; // Aujourd'hui par défaut

    try {
        // Récupérer les ventes du jour avec leur mode de paiement et montant final
        const [rows] = await pool.query(
            `SELECT payment_method, 
                    COALESCE(SUM(final_amount), 0) as total
             FROM sales
             WHERE user_id = ?
               AND DATE(sale_date) = ?
               AND status = 'completed'
             GROUP BY payment_method`,
            [userId, targetDate]
        );

        // Structurer la réponse
        const result = {
            cash: 0,
            wave: 0,
            orange: 0,
            card: 0,
            transfer: 0,
            other: 0
        };

        rows.forEach(row => {
            const method = row.payment_method || 'other';
            if (result.hasOwnProperty(method)) {
                result[method] = parseFloat(row.total);
            } else {
                result.other += parseFloat(row.total);
            }
        });

        res.json({
            date: targetDate,
            totals: result,
            grandTotal: Object.values(result).reduce((a, b) => a + b, 0)
        });
    } catch (err) {
        console.error('Erreur daily-payments:', err);
        res.status(500).json({ error: err.message });
    }
});
// ========== ROUTE HISTORIQUE ==========
app.get('/api/history', authenticate, async (req, res) => {
    const [sales] = await pool.query(`SELECT 'sale' as type, s.id, s.final_amount as amount, s.sale_date as date, c.name as client_name, s.status FROM sales s LEFT JOIN clients c ON s.client_id = c.id WHERE s.user_id = ? ORDER BY s.sale_date DESC LIMIT 50`, [req.user.id]);
    const [movements] = await pool.query(`SELECT 'stock' as type, sm.id, sm.quantity_change as amount, sm.created_at as date, p.name as product_name, sm.type as movement_type FROM stock_movements sm JOIN products p ON sm.product_id = p.id WHERE sm.user_id = ? ORDER BY sm.created_at DESC LIMIT 50`, [req.user.id]);
    const history = [...sales, ...movements].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0,50);
    res.json(history);
});

// ===== GESTION DES ERREURS =====
app.use((err, req, res, next) => {
    console.error('❌ Erreur serveur:', err);
    if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
    }
});

// ===== ROUTE 404 =====
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Route API non trouvée' });
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// ===== LANCEMENT =====
initAndStart();