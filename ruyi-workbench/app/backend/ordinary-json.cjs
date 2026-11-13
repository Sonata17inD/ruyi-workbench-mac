'use strict';
function copyOrdinaryJsonData(value, freeze = true) {
  const ancestors = new Set();
  let nodes = 0;
  const copy = (item, depth) => {
    if (++nodes > 1000000 || depth > 128) throw new Error('execution argument snapshot exceeds capacity');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('execution arguments require finite numbers');
      return item === 0 ? 0 : item;
    }
    if (!item || typeof item !== 'object' || (typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(item)))
      throw new Error('execution arguments require ordinary JSON values');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null)
      throw new Error('execution arguments require ordinary JSON objects');
    if (ancestors.has(item)) throw new Error('execution arguments cannot be cyclic');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    const result = array ? Object.setPrototypeOf([], null) : Object.create(null);
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1000000 || keys.length !== length + 1)
        throw new Error('execution arguments require dense ordinary JSON arrays');
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new Error('execution arguments cannot contain accessors or array holes');
        result[index] = copy(descriptor.value, depth + 1);
      }
    } else {
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new Error('execution arguments require enumerable JSON data properties');
        result[key] = copy(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
    return freeze ? Object.freeze(result) : result;
  };
  return copy(value, 0);
}
module.exports = { copyOrdinaryJsonData };
