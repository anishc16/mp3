const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    name: {
        type: String, required: true, cast: false,
        validate: value => value.trim().length > 0
    },
    email: {
        type: String, required: true, unique: true, cast: false,
        validate: value => value.trim().length > 0
    },
    pendingTasks: { type: [String], default: [] },
    dateCreated: { type: Date, default: Date.now, immutable: true }
});

module.exports = mongoose.model('User', UserSchema);
