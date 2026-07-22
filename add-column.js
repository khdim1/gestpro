// add-column.js (version corrigée)
const mysql = require('mysql2/promise');
require('dotenv').config();

async function addColumns() {
    const config = {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '10516'),
        user: process.env.DB_USER || 'avnadmin',
        password: process.env.DB_PASSWORD, // ✅ Plus de mot de passe en clair
        database: process.env.DB_NAME || 'defaultdb',
        ssl: { rejectUnauthorized: false }
    };

    try {
        const pool = await mysql.createPool(config);
        console.log('✅ Connecté à la base');

        await pool.query('ALTER TABLE proforma_invoices ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0');
        console.log('✅ Colonne tax_rate ajoutée à proforma_invoices');

        try {
            await pool.query('ALTER TABLE sales ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0');
            console.log('✅ Colonne tax_rate ajoutée à sales');
        } catch (e) {
            if (e.message.includes('Duplicate column')) {
                console.log('ℹ️ La colonne tax_rate existe déjà dans sales');
            } else {
                throw e;
            }
        }

        await pool.end();
        console.log('✅ Migration terminée avec succès');
    } catch (err) {
        console.error('❌ Erreur:', err.message);
        process.exit(1);
    }
}

addColumns();