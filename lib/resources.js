const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('./errors');
const { isId, userFields, taskFields, badRequest } = require('./validation');

async function findResource(Model, id, session) {
    if (!isId(id)) throw new ApiError(404, `${Model.modelName} not found.`);
    const resource = await Model.findById(id).session(session || null);
    if (!resource) throw new ApiError(404, `${Model.modelName} not found.`);
    return resource;
}

function transaction(work) {
    return mongoose.connection.transaction(work, {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary'
    });
}

async function saveUser(id, body) {
    return transaction(async session => {
        // URL existence takes precedence over all body validation.
        const user = id === undefined ? new User() : await findResource(User, id, session);
        const fields = userFields(body);
        const duplicate = await User.exists({ email: fields.email, _id: { $ne: user._id } }).session(session);
        if (duplicate) badRequest('Email is already used by another user.');

        const tasks = await Task.find({ _id: { $in: fields.pendingTasks } }).session(session);
        // The README gives invalid values (including completed tasks) precedence over missing references.
        if (tasks.some(task => task.completed)) badRequest('pendingTasks cannot contain completed tasks.');
        if (tasks.length !== fields.pendingTasks.length) throw new ApiError(404, 'A referenced task was not found.');

        const userId = user._id.toString();
        const removed = user.pendingTasks.filter(taskId => !fields.pendingTasks.includes(taskId));
        user.set(fields);
        await user.save({ session });

        await Task.updateMany({ _id: { $in: removed }, assignedUser: userId }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
        await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: fields.pendingTasks } }, {
            $pull: { pendingTasks: { $in: fields.pendingTasks } }, $inc: { __v: 1 }
        }, { session });
        await Task.updateMany({ _id: { $in: fields.pendingTasks } }, {
            $set: { assignedUser: userId, assignedUserName: user.name }
        }, { session });
        // Completed tasks retain their owner and also follow user renames.
        await Task.updateMany({ assignedUser: userId }, {
            $set: { assignedUserName: user.name }
        }, { session });
        return user.toObject();
    });
}

async function saveTask(id, body) {
    return transaction(async session => {
        const task = id === undefined ? new Task() : await findResource(Task, id, session);
        const fields = taskFields(body);
        let owner;
        if (fields.assignedUser) {
            owner = await User.findById(fields.assignedUser).session(session);
            if (!owner) throw new ApiError(404, 'The assigned user was not found.');
            if (fields.assignedUserName !== undefined && fields.assignedUserName !== owner.name) {
                badRequest('assignedUserName must match the assigned user\'s name.');
            }
            fields.assignedUserName = owner.name;
        } else {
            fields.assignedUserName = 'unassigned';
        }

        const taskId = task._id.toString();
        const owners = [...new Set([task.assignedUser, fields.assignedUser].filter(Boolean))];
        // Touch both owners even for completed tasks. The version increment forces a write
        // conflict with concurrent rename/delete, preventing snapshot-isolation write skew.
        await User.updateMany({ $or: [{ _id: { $in: owners } }, { pendingTasks: taskId }] }, {
            $pull: { pendingTasks: taskId }, $inc: { __v: 1 }
        }, { session });
        if (owner && !fields.completed) {
            await User.updateOne({ _id: owner._id }, { $addToSet: { pendingTasks: taskId } }, { session });
        }
        task.set(fields);
        await task.save({ session });
        return task.toObject();
    });
}

async function deleteUser(id) {
    return transaction(async session => {
        const user = await findResource(User, id, session);
        await user.deleteOne({ session });
        await Task.updateMany({ assignedUser: user._id.toString() }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
    });
}

async function deleteTask(id) {
    return transaction(async session => {
        const task = await findResource(Task, id, session);
        const owners = task.assignedUser ? [task.assignedUser] : [];
        await User.updateMany({ $or: [{ pendingTasks: task._id.toString() }, { _id: { $in: owners } }] }, {
            $pull: { pendingTasks: task._id.toString() }, $inc: { __v: 1 }
        }, { session });
        await task.deleteOne({ session });
    });
}

module.exports = { findResource, saveUser, saveTask, deleteUser, deleteTask };
