const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixStatus() {
    const config = {
        host: process.env.DB_HOST || 'mysql-dfeed9a-nkhadim066-b7bd.g.aivencloud.com',
        port: parseInt(process.env.DB_PORT || '10516'),
        user: process.env.DB_USER || 'avnadmin',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'defaultdb',
        ssl: { rejectUnauthorized: false }
    };

    try {
        const pool = await mysql.createPool(config);
        console.log('✅ Connecté à la base');

        // Vérifier si la colonne status existe
        const [columns] = await pool.query(`SHOW COLUMNS FROM sales LIKE 'status'`);
        if (columns.length === 0) {
            // Ajouter la colonne si elle n'existe pas
            await pool.query(`ALTER TABLE sales ADD COLUMN status ENUM('completed','pending','cancelled') DEFAULT 'completed'`);
            console.log('✅ Colonne status ajoutée');
        } else {
            console.log('ℹ️ Colonne status existe déjà, vérification du type...');
            const type = columns[0].Type;
            if (!type.includes('enum')) {
                // Si ce n'est pas un ENUM, le modifier
                await pool.query(`ALTER TABLE sales MODIFY COLUMN status ENUM('completed','pending','cancelled') DEFAULT 'completed'`);
                console.log('✅ Colonne status corrigée en ENUM');
            } else {
                console.log('✅ Colonne status est déjà de type ENUM');
            }
        }

        // Mettre à jour les valeurs NULL
        await pool.query(`UPDATE sales SET status = 'completed' WHERE status IS NULL`);
        console.log('✅ Statuts mis à jour');

        await pool.end();
        console.log('✅ Correction terminée');
    } catch (err) {
        console.error('❌ Erreur:', err.message);
    }
}

fixStatus();