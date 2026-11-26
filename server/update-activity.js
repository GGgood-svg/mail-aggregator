'use strict';

const requestActivity = Symbol('updateRequestActivity');

// Express 4 doesn't wait on a handler's promise. Track the promise separately
// from the response: a client can disconnect while an IMAP/DB write is in flight.
function track(handler) {
  return function tracked(req, res, next) {
    const admission = req[requestActivity];
    if (!admission) return handler(req, res, next);
    if (admission.closed) return;
    const done = admission.enter();
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(done);
      done();
      return result;
    } catch (err) { done(); throw err; }
  };
}

module.exports = { requestActivity, track };
