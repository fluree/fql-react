function isStorageAvailable() {
  try {
    var storage = window.localStorage, x = '__storage_test__';
    storage.setItem(x, x);
    storage.removeItem(x);
    return true;
  } catch(e) {
    return false;
  }
}

var storageAvailable = isStorageAvailable();

function setItem(k, v) {
  if (storageAvailable) {
    window.localStorage.setItem(k, JSON.stringify(v));
  } else {
    return false;
  }
}

function getItem(k) {
  if (storageAvailable) {
    const v = window.localStorage.getItem(k);
    return JSON.parse(v);
  } else {
    return null;
  }
}

function removeItem(k) {
  if (storageAvailable) {
    window.localStorage.removeItem(k);
    return true;
  } else {
    return false;
  }
}

module.exports = {setItem, getItem, removeItem};
