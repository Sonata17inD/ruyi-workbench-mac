'use strict';
// Serialize each key independently; rejected work never poisons the following operation.
function runKeyedChain(chains, key, work) {
  const previous = chains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  chains.set(key, current);
  current.then(() => {}, () => {}).then(() => { if (chains.get(key) === current) chains.delete(key); });
  return current;
}

module.exports = { runKeyedChain };
