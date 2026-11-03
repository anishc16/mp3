/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    const resources = require('../lib/resources');
    const addRoutes = require('./resources');
    require('./home')(router);
    addRoutes(router, 'users', require('../models/user'), resources.saveUser, resources.deleteUser, 0);
    addRoutes(router, 'tasks', require('../models/task'), resources.saveTask, resources.deleteTask, 100);
    app.use('/api', router);
};
