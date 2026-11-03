module.exports = function (router) {
    router.get('/', (req, res) => {
        res.json({ message: 'Task management API', data: { users: '/api/users', tasks: '/api/tasks' } });
    });
    return router;
};
