#!/bin/bash
set -e

# Source the environment variables
source /.env

# Wait for PostgreSQL to be ready
until psql -U $DB_USER -d postgres -c '\q' 2>/dev/null; do
  echo "Postgres is unavailable - sleeping"
  sleep 1
done

echo "PostgreSQL is up - executing commands"

# Check if database exists
psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname "postgres" <<-EOSQL
    SELECT 'CREATE DATABASE ${DB_NAME}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}');
EOSQL

# Create the database explicitly if it doesn't exist
psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname "postgres" <<-EOSQL
    CREATE DATABASE ${DB_NAME};
EOSQL

# Run schema on the new database
psql -U $DB_USER -d ${DB_NAME} -f /schema.sql