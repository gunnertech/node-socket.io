const mongoose = require('mongoose');
const lodash = require('lodash');
const Promise = require('bluebird');

const schema = new mongoose.Schema({
  drops: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Drop' }],
  items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  battle: { type: mongoose.Schema.Types.ObjectId, ref: 'Battle' }
});

schema.set('toJSON', { getters: true, virtuals: true });
schema.set('toObject', { getters: true, virtuals: true });

schema.pre('save', function (next) {
  let self = this;
  mongoose.model('User').findById(this.user)
  .then((user) => {
    user.currentRun = self;
    return user.save() 
  })
  .then((user) => {
    return next();
  })
});

schema.post('save', function (run) {
  var self = run;

  mongoose.model('Drop').update({ _id: { $in : self.drops } }, { run: self._id })
  .then(() => {
    return mongoose.model('Drop').find({ _id: { $in : self.drops } }).distinct("item")
    .then((itemIds) => {
      return mongoose.model('Run').update({ _id: self._id }, { items: itemIds }).then(() => itemIds )
    })
    .then((itemIds) => {
      return Promise.all([
        mongoose.model('Battle').findById(self.battle),
        mongoose.model('Run').count({battle: self.battle}),
        itemIds
      ])
      .spread((battle, runCount, itemIds) => {
        battle.dropRates = battle.dropRates || {};
        
        itemIds = lodash.uniq(itemIds.concat(Object.keys(battle.dropRates)));

        return Promise.each(itemIds, (item) => {

          return mongoose.model('Run').count({battle: self.battle, items: item})
          .then((hitCount) => {
            battle.dropRates[item] = {
              hits: (hitCount||0),
              total: runCount,
              rate: ((hitCount * 1.0) / (runCount * 1.0) || 0.0)
            }
          });
        }).return(battle)
        .then((battle) => {
          return mongoose.model('Battle').update({_id: battle._id},{dropRates: battle.dropRates});
        });
      });
    });
  });
});


module.exports = mongoose.model('Run', schema);