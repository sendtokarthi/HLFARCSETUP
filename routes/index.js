const express = require('express');
const oracledb = require('oracledb');
const router = express.Router();

// Initialize the connection pool
async function initPool(user, password, connectString) {
    try {
        await oracledb.createPool({
            user: user,
            password: password,
            connectString: connectString,
            poolMin: 10,
            poolMax: 10,
            poolIncrement: 0
        });
        console.log('Connection pool started');
    } catch (err) {
        console.error('Error starting connection pool', err);
        process.exit(1);
    }
}

// Close the connection pool
async function closePoolAndExit() {
    console.log('\nTerminating');
    try {
        await oracledb.getPool().close(10);
        console.log('Connection pool closed');
        process.exit(0);
    } catch (err) {
        console.error('Error closing connection pool', err);
        process.exit(1);
    }
}

// Handle process termination signals to close the pool properly
process
    .once('SIGTERM', closePoolAndExit)
    .once('SIGINT', closePoolAndExit);

router.get('/', (req, res) => {
    res.redirect('/login');
});

router.get('/login', (req, res) => {
    res.render('login');
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const connection = await oracledb.getConnection({
            user: username,
            password: password,
            connectString: 'usws1prsdb03.hrbl.net:1545/SLTST'
        });
        req.session.user = { username, password, connectString: 'usws1prsdb03.hrbl.net:1545/SLTST' };
        await connection.close();
        await initPool(username, password, 'usws1prsdb03.hrbl.net:1545/SLTST');
        res.redirect('/home');
    } catch (err) {
        res.render('login', { error: 'Invalid username or password' });
    }
});

router.get('/home', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    try {
        const connection = await oracledb.getConnection();
        const result = await connection.execute('SELECT DISTINCT MODULE FROM TABLEINFO');
        await connection.close();
        res.render('home', { modules: result.rows });
    } catch (err) {
        res.redirect('/login');
    }
});

router.post('/tables', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const { module } = req.body;
    try {
        const connection = await oracledb.getConnection();
        const result = await connection.execute('SELECT TABLE_NAME FROM TABLEINFO WHERE MODULE = :module', { module });
        await connection.close();
        res.render('tables', { tables: result.rows, module });
    } catch (err) {
        res.redirect('/login');
    }
});

router.post('/view-table', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const { table } = req.body;
    try {
        const connection = await oracledb.getConnection();

        // Fetch column names and types
        const columnsResult = await connection.execute(
            'SELECT COLUMN_NAME, DATA_TYPE FROM user_tab_columns WHERE table_name = :tableName',
            { tableName: table.toUpperCase() }
        );
        const columns = columnsResult.rows.map(row => ({ name: row[0], type: row[1] }));

        // Fetch table data
        const dataResult = await connection.execute(`SELECT * FROM ${table}`);
        await connection.close();
        res.render('view-table', { rows: dataResult.rows, columns, table });
    } catch (err) {
        console.error(err);
        res.redirect('/login');
    }
});

router.post('/update-table', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const { table, ...data } = req.body;

    if (!data) {
        return res.redirect(`/view-table?table=${table}`);
    }

    // Fetch column types to identify date columns
    let columns;
    try {
        const connection = await oracledb.getConnection();
        const columnsResult = await connection.execute(
            'SELECT COLUMN_NAME, DATA_TYPE FROM user_tab_columns WHERE table_name = :tableName',
            { tableName: table.toUpperCase() }
        );
        columns = columnsResult.rows.map(row => ({ name: row[0], type: row[1] }));
        await connection.close();
    } catch (err) {
        console.error(err);
        return res.redirect('/login');
    }

    // Parse the data
    const parsedData = Object.keys(data).reduce((acc, key) => {
        const [_, rowIndex, colName] = key.match(/data\[(\d+)\]\[(.+)\]/);
        if (!acc[rowIndex]) {
            acc[rowIndex] = {};
        }
        const column = columns.find(col => col.name === colName);
        const value = data[key];
        if (column && column.type === 'DATE') {
            acc[rowIndex][colName] = value; // Keep date as string to format it in the query
        } else {
            acc[rowIndex][colName] = value;
        }
        return acc;
    }, {});

    try {
        const connection = await oracledb.getConnection();

        for (const rowIndex in parsedData) {
            const row = parsedData[rowIndex];
            const updateColumns = [];
            const updateValues = {};
            for (const column in row) {
                if (columns.find(col => col.name === column && col.type === 'DATE')) {
                    updateColumns.push(`${column} = TO_DATE(:${column}, 'DD-MON-YYYY')`);
                } else {
                    updateColumns.push(`${column} = :${column}`);
                }
                updateValues[column] = row[column];
            }
            const updateQuery = `UPDATE ${table} SET ${updateColumns.join(', ')} WHERE ORG_ID=:ORG_ID `;
            await connection.execute(updateQuery, updateValues);
        }
        await connection.commit();
        await connection.close();
        res.redirect('/home');
    } catch (err) {
        console.error(err);
        res.redirect('/login');
    }
});

module.exports = router;