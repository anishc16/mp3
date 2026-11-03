const express = require('express');
const mongoose = require('mongoose');
const { errorHandler } = require('./lib/errors');
const User = require('./models/user');
const Task = require('./models/task');

require('dotenv').config({ quiet: true });

const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
require('./routes')(app, express.Router());
app.use((req, res) => res.status(404).json({ message: 'Endpoint not found.', data: null }));
app.use(errorHandler);

async function start() {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
    await mongoose.connect(process.env.MONGODB_URI);
    // Wait for the unique email index before accepting requests.
    await Promise.all([User.init(), Task.init()]);
    console.log('Database connected.');
    const port = process.env.PORT || 3000;
    return new Promise((resolve, reject) => {
        const server = app.listen(port);
        server.once('error', reject);
        server.once('listening', () => {
            console.log(`Server running on port ${server.address().port}`);
            resolve(server);
        });
    });
}

if (require.main === module) {
    start().catch(async () => {
        console.error('Server startup failed. Check database configuration, connectivity, and port availability.');
        await mongoose.disconnect();
        process.exitCode = 1;
    });
}

module.exports = { app, start };
