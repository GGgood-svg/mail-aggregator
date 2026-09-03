let activeOperation = null;

function acquire(operation) {
  if (activeOperation) return false;
  activeOperation = operation;
  return true;
}

function release(operation) {
  if (activeOperation === operation) activeOperation = null;
}

function current() {
  return activeOperation;
}

module.exports = { acquire, release, current };
