import 'console-polyfill';
import hoistNonReactStatics from 'hoist-non-react-statics';
import { Component, createElement, Children } from 'react';
import PropTypes from 'prop-types';
import localStorage from './localStorage';

let SHOULD_LOG = true;

// id counter to be used for various things that require unique identifiers
var idCounter = 0;
function nextId() {
  return idCounter++;
}

// a stateful connection id, incremented for each connection.
var connIdCounter = 0;

// map of each connection to an object containing keys:
// - ready (boolean)
// - time - a time over-ride for all 'current' queries in the UI
// - unauthorizedCallbacks - optionally provided functions to call when something is unauthorized
var connStatus = {};

// a map of each component ID to it's object
var componentIdx = {};

// for async calls to the worker, maintains the callback to execute with the result, when applicable
var callbackRegistry = {};

// holds worker reference globally. Don't initiate until first request for connection
var fqlWorker;

// worker queue
var workerQueue = [];

// worker initialized
var workerInitialized = false;


function addUnathorizedCallback(connId, cb) {
  const callbackID = Math.random();
  var callbackMap = connStatus[connId]['unauthorizedCallbacks'] || {};
  // tag callback function so we can easily locate and remove later.
  cb.__fluree_cb_id = callbackID;
  callbackMap[callbackID] = cb;
  connStatus[connId]['unauthorizedCallbacks'] = callbackMap;
  return true;
}

function removeUnauthorizedCallback(connId, cb) {
  const callbackID = cb.__fluree_cb_id;
  if (callbackID)
    delete connStatus[connId]['unauthorizedCallbacks'][callbackID];
  return !!callbackID;
}

function executeUnauthorizedCallbacks(connId, data) {
  if (connStatus[connId]['unauthorizedCallbacks'])
    for (var key in connStatus[connId]['unauthorizedCallbacks']) {
      const cb = connStatus[connId]['unauthorizedCallbacks'][key];
      cb(data);
    }
}

// worker.onmessage handler
function workerMessageHandler(e) {
  const msg = e.data;
  var cb;

  SHOULD_LOG && console.log("Worker received message: " + JSON.stringify(msg));

  // if unauthorized response, trigger any registered unauthorizedCallbacks
  if (msg.data && msg.data.status === 401)
    executeUnauthorizedCallbacks(msg.conn, msg.data);

  switch (msg.event) {
    case "connInit":
      workerInitialized = true;
      workerQueue.forEach(workerInvoke);
      workerQueue = [];
      break;

    case "connStatus":
      const response = msg.data || {};
      const statusCode = response.status;
      if (connStatus[msg.conn]) {
        switch (statusCode) {
          case 200:
            connStatus[msg.conn].ready = true;
            break;
          case 401: // authorization error, need to log in
            connStatus[msg.conn].ready = false;
            connStatus[msg.conn].token = null;
            break;
          default:
            console.warn("Invalid connection response status: " + JSON.stringify(response));
            break;
        }
      }
      break;

    case "connClosed":
      cb = callbackRegistry[msg.ref];
      if (cb) {
        delete callbackRegistry[msg.ref];
        cb(msg.data);
      }
      break;

    case "connLogout":
      cb = callbackRegistry[msg.ref];
      if (cb) {
        delete callbackRegistry[msg.ref];
        cb(msg.data);
      }
      break;

    case "setState":
      const comp = componentIdx[msg.ref];
      if (comp) {
        comp.setState(msg.data);
      } else {
        SHOULD_LOG && console.warn("Component no longer registered: " + msg.ref);
      }
      break;

    case "remoteInvoke":
      // check for a callback
      cb = callbackRegistry[msg.ref];
      if (cb) {
        delete callbackRegistry[msg.ref];
        cb(msg.data);
      }
      break;

    case "login":
      // if login successful, update conn's connStatus
      if (msg.data.status === 200) {
        connStatus[msg.conn].token = msg.data.body.token;
      }
      // if there was a callback passed to login(), execute
      cb = callbackRegistry[msg.ref];
      if (cb) {
        delete callbackRegistry[msg.ref];
        cb(msg.data);
      }
      break;

    default:
      SHOULD_LOG && console.warn("Unreconized event from worker: " + msg.event + ". Full message: " + JSON.stringify(msg));
      break;
  }
  return;
}

function parseToken(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch (e) {
    return {};
  }
}


function setStateCb(conn, id, stateUpdate) {
  const comp = componentIdx[id];

  if (comp) {
    comp.setState(stateUpdate);
  } else {
    SHOULD_LOG && console.warn("Component no longer registered: " + compId);
  }
}

// we use a global to track connection state, get method for it
function isReady(connId) {
  return connStatus[connId].ready;
}

// we use a global to track connection state, get method for it
function isClosed(connId) {
  const connObj = connStatus[connId];
  return (connObj && Object.keys(connObj).length === 0);
}

function workerInvoke(obj) {
  if (obj.cb) {
    if (typeof obj.cb === 'function') {
      obj.ref = obj.ref || nextId();
      callbackRegistry[obj.ref] = obj.cb;
    } else {
      console.warn('Callback supplied was not a function:', obj);
    }
    delete obj.cb;
  }

  if (workerInitialized) {
    fqlWorker.postMessage(obj);
  } else {
    workerQueue.push(obj);
  }

  return true;
}

// Register a query, provide the connection, component ID, query and query options
export function registerQuery(conn, compId, query, opts, forceUpdate) {
  const invokeObj = {
    conn: conn.id,
    action: "registerQuery",
    ref: compId,
    params: [compId, query, opts, forceUpdate]
  };
  return workerInvoke(invokeObj);
}

// Remove query from registry
export function unregisterQuery(conn, compId) {
  workerInvoke({
    conn: conn.id,
    ref: compId,
    action: "unregisterQuery",
    params: [compId]
  });
}

function queryIsValid(query) {
  if (query !== null && (Array.isArray(query) || typeof query === "object")) {
    const graph = Array.isArray(query) ? query : query.graph;
    if (Array.isArray(graph) && graph.length > 0) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

function workerErrorHandler(error) {
  console.error('Web worker error', JSON.stringify(error));
}

function instanceFromHostname() {
  const url = window.location.hostname || "";
  const [_, instance] = url.match(/([^./]+)\.flur\.ee/) || []; // eslint-disable-line
  return instance;
}


// Create a new connection with settings object.
// need to provide url, instance and token keys at minumum.
export function ReactConnect(connSettings) {
  // initialize worker if not already done
  if (!fqlWorker) {
    fqlWorker = new Worker(connSettings.workerUrl || "/fqlClient.js");
    fqlWorker.onmessage = workerMessageHandler;
    fqlWorker.onerror = workerErrorHandler;
  }

  connIdCounter++;
  const connId = connIdCounter;
  const instance = connSettings.instance || instanceFromHostname();
  const localStorageKey = instance + '/login';
  const savedSession = localStorage.getItem(localStorageKey) || {};

  const baseSetting = {
    id: connId,
    log: true,
    removeNamespace: true, // by default remove namespace from results
    instance: instance,
    url: connSettings.url || 'https://' + instance,
    token: connSettings.token || savedSession.token,
  };

  const settings = Object.assign(baseSetting, connSettings);

  SHOULD_LOG = settings.log;

  const conn = {
    id: connId,
    isReady: () => isReady(connId),
    isClosed: () => isClosed(connId),
    login: function (username, password, cb, rememberMe) {
      return workerInvoke({
        conn: connId,
        action: "login",
        params: [username, password],
        cb: function (result) {
          if (result.status === 200 && rememberMe) {
            localStorage.setItem(localStorageKey, result.body);
          }
          if (cb && typeof cb === 'function') {
            cb(result);
          }
        }
      });
    },
    invoke: function (action, params, cb) {
      const invokeStatment = [action, params];
      return workerInvoke({
        conn: connId,
        action: "remoteInvoke",
        params: [invokeStatment],
        cb: cb
      });
    },
    getUser: function () {
      const userId = parseToken(connStatus[connId].token)['sub'];
      return userId ? ["user/flake", userId] : null;
    },
    getInstance: function () {
      return connSettings.instance;
    },
    getToken: function() {
      return connStatus[connId].token;
    },
    isAuthenticated: function () {
      return !!connStatus[connId].token;
    },
    reset: function (cb) {
      connStatus[connId] = {
        ready: false,
        token: null
      };
      return workerInvoke({
        conn: connId,
        action: "reset",
        params: [],
        cb: cb
      });
    },
    logout: function (cb) {
      connStatus[connId] = {
        ready: false,
        token: null
      };
      // if we stored credentials for 'rememberMe', clear them
      localStorage.removeItem(localStorageKey);
      return workerInvoke({
        conn: connId,
        action: "logout",
        params: [],
        cb: cb
      });
    },
    close: function (cb) {
      // clear out connection state held locally
      connStatus[connId] = {};
      return workerInvoke({
        conn: connId,
        action: "close",
        params: [],
        cb: cb
      });
    },
    forceTime: function (t) {
      if (t && !(t instanceof Date)) {
        console.error("forceTime requires a date as a parameter, provided: " + t)
        return;
      }
      const tISOString = t ? t.toISOString() : null;
      const componentIds = Object.keys(componentIdx);
      // update central conn status to use this t for any new components rendered
      connStatus[connId].t = tISOString;
      // update options of all mounted components to add or remove 't' as applicable
      componentIds.map(id => {
        let component = componentIdx[id];

        if (t)
          component.opts.t = tISOString;
        else
          delete component.opts.t;

        registerQuery(component.conn, component.id, component.query, component.opts);
      })
    },
    getTime: function () {
      return connStatus[connId].t ? new Date(Date.parse(connStatus[connId].t)) : null;
    },
    unauthorizedCallback: {
      add: function (cb) { addUnathorizedCallback(connId, cb) },
      remove: function (cb) { removeUnauthorizedCallback(connId, cb) }
    }
  };

  // initialize connection status, set ready to false
  connStatus[connId] = {
    ready: false,
    // optional unauthorizedCallback will be called when a request is unauthorized
    unauthorizedCallback: connSettings.unauthorizedCallback,
    token: settings.token
  };

  // initiate our connection in the web worker
  workerInvoke({
    conn: 0, // conn 0 means not connection specific
    action: "connect",
    params: [settings]
  });

  // return connection object
  return conn;
}


function getDisplayName(component) {
  return component.displayName || component.name || "Component";
}

// wraps react components that need a particular connection, making the
// connection available via the context to children
export class FlureeProvider extends Component {
  static propTypes = {
    conn: PropTypes.object.isRequired
  };

  static childContextTypes = {
    conn: PropTypes.object.isRequired
  };

  constructor(props, context) {
    super(props, context);

    if (!props.conn) {
      throw "FlureeProvider was not provided a conn prop, which should be a connection object."
    }

    this.conn = props.conn;
  };

  getChildContext() {
    return {
      conn: this.conn
    }
  };

  render() {
    return Children.only(this.props.children);
  };
}


// given a query and options, returns a vector of variables that
// were not provided via options. We use this to look for the variables
// in props
function getMissingVars(flurQL, opts) {
  const vars = flurQL.vars;

  if (!vars || !Array.isArray(vars)) {
    return [];
  }

  if (opts && opts.vars) {
    return vars.filter((v) => { return !opts.vars[v]; });
  } else {
    return vars;
  }
}

// Create an empty map of the top level query nodes so less
// boilerplate is required to test if a property exists in the
// wrapped component
function fillDefaultResult(query) {
  if (!query) return {};

  const graph = query.graph || query;

  if (!Array.isArray(graph)) { // invalid graph
    return;
  }

  var defaultResult = {};

  graph.map(([stream, opts]) => {
    if (opts.as) {
      defaultResult[opts.as] = null;
    } else {
      defaultResult[stream] = null;
    }
  });

  return defaultResult;
}

function wrapComponent(WrappedComponent, query, opts) {
  const flurQLDisplayName = `Fluree(${getDisplayName(WrappedComponent)})`;

  class FlurQL extends Component {
    static displayName = flurQLDisplayName;
    static WrappedComponent = WrappedComponent;
    static contextTypes = {
      conn: PropTypes.object.isRequired
    };

    constructor(props, context) {
      super(props, context);
      this.conn = context.conn;
      this.opts = Object.assign({ vars: {} }, opts);
      this.id = nextId();
      this.queryIsFunction = (typeof query === "function")
      this.query = this.queryIsFunction ? query(props, this.context) : query;
      this.isValidQuery = this.query && queryIsValid(this.query);
      this.missingVars = this.isValidQuery ? getMissingVars(this.query, this.opts) : []; // list of vars we need to check props for
      this.state = {
        result: this.isValidQuery ? fillDefaultResult(this.query) : {},
        error: this.query && !this.isValidQuery ? { status: 400, message: "Query is not valid: " + JSON.stringify(this.query) } : null,
        warning: this.query ? null : "No query yet, waiting...",
        status: "pending",
        loading: true
      };

      if (!this.conn) {
        throw "Could not find a Fluree connection (conn) in the context of " + flurQLDisplayName + ".";
      }
    }

    componentWillMount() {
      // get any missing vars from props and update this.opts with them
      if (this.missingVars.length !== 0) {
        this.missingVars.forEach((v) => {
          if ('currentUser' === v) {
            this.opts.vars[v] = this.conn.getUser();
          } else {
            this.opts.vars[v] = this.props[v];
          }
        });
      }

      // register this component for later re-render calling, etc.
      componentIdx[this.id] = this;
      // apply time over-ride to options if there is one
      if (connStatus[this.conn.id].t)
        this.opts.t = connStatus[this.conn.id].t;

      if (this.query && this.isValidQuery) {
        registerQuery(this.conn, this.id, this.query, this.opts);
      }
    }

    componentWillUnmount() {
      unregisterQuery(this.conn, this.id);
      delete componentIdx[this.id];
    }

    componentWillReceiveProps(nextProps) {
      if (this.queryIsFunction) {
        const newQuery = query(nextProps, this.context);
        this.query = newQuery;
        this.isValidQuery = queryIsValid(this.query);
        if (this.query && this.isValidQuery) {
          registerQuery(this.conn, this.id, this.query, this.opts);
        }
      } else {
        // check if any of the missing vars changed with the new props
        let didMissingVarsChange = false;

        for (let i = 0; i < this.missingVars.length; i++) {
          const varName = this.missingVars[i];
          if (this.props[varName] !== nextProps[varName]) {
            didMissingVarsChange = true;
          }
        }

        if (didMissingVarsChange === true) {
          this.missingVars.forEach((v) => {
            if ('currentUser' === v) {
              this.opts.vars[v] = this.conn.getUser();
            } else {
              this.opts.vars[v] = nextProps[v];
            }
          });

          registerQuery(this.conn, this.id, this.query, this.opts);
        }
      }
    }

    render() {
      const result = this.state.result;
      const data = {
        id: this.id,
        result: result,
        forceUpdate: function () {
          if (this.query && this.isValidQuery)
            registerQuery(this.conn, this.id, this.query, this.opts, true);
        }.bind(this),
        deltas: this.state.deltas,
        error: this.state.error,
        warning: this.state.warning,
        status: this.state.status,
        loading: !(this.state.status === "loaded" || this.state.status === "error"),
        get: function get(keySeq, defaultValue) {
          keySeq = Array.isArray(keySeq) ? keySeq : [keySeq];
          let obj = result;
          let idx = 0;
          const length = keySeq.length;

          while (obj != null && idx < length) {
            obj = obj[keySeq[idx++]];
          }

          return (idx == length && obj != null) ? obj : ((defaultValue === undefined) ? obj : defaultValue);
        }
      };

      const childProps = Object.assign({}, this.props, { data: data, invoke: this.conn.invoke });

      return createElement(WrappedComponent, childProps);
    }
  }

  return hoistNonReactStatics(FlurQL, WrappedComponent, {});
}

export function flureeQL(query, opts) {
  return function (WrappedComponent) {
    return wrapComponent(WrappedComponent, query, opts);
  }
}
