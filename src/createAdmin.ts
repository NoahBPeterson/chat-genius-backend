import bcrypt from 'bcrypt';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const { Pool } = pg;
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT as string),
});

const createAdmin = async () => {
    const email = process.argv[2];
    const password = process.argv[3];
    if (!email || !password) {
        console.error('Usage: node createAdmin.js <email> <password>');
        process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
        'INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)',
        [email, hashedPassword, 'Admin User', 'admin']
    );
    console.log(`Admin user created: ${email}`);
};

createAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
});
