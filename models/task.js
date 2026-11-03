const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
    name: {
        type: String, required: true, cast: false,
        validate: value => value.trim().length > 0
    },
    description: { type: String, default: '', cast: false },
    deadline: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    assignedUser: { type: String, default: '', cast: false },
    assignedUserName: { type: String, default: 'unassigned', cast: false },
    dateCreated: { type: Date, default: Date.now, immutable: true }
});

module.exports = mongoose.model('Task', TaskSchema);
