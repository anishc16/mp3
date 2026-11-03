const { ApiError } = require('../lib/errors');
const { isId } = require('../lib/validation');
const { list, selection, execute } = require('../lib/queries');

module.exports = function (router, path, Model, save, remove, defaultLimit) {
    router.route(`/${path}`)
        .get(async (req, res) => {
            res.json({ message: 'OK', data: await list(Model, req.query, defaultLimit) });
        })
        .post(async (req, res) => {
            const data = await save(undefined, req.body);
            res.status(201).json({ message: `${Model.modelName} created.`, data });
        });

    router.route(`/${path}/:id`)
        .get(async (req, res) => {
            if (!isId(req.params.id)) throw new ApiError(404, `${Model.modelName} not found.`);
            const data = await execute(Model.findById(req.params.id).select(selection(req.query)).lean());
            if (!data) throw new ApiError(404, `${Model.modelName} not found.`);
            res.json({ message: 'OK', data });
        })
        .put(async (req, res) => {
            const data = await save(req.params.id, req.body);
            res.json({ message: `${Model.modelName} replaced.`, data });
        })
        .delete(async (req, res) => {
            await remove(req.params.id);
            res.status(204).end();
        });
};
