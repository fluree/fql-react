import hoistNonReactStatics from 'hoist-non-react-statics';
import {
  Component,
  createElement,
  PropTypes,
} from 'react';

// id counter to be used for various things that require unique identifiers
var idCounter = 0;
function nextId() {
    return idCounter++;
}

// a stateful connection id, incremented for each connection.
var connIdCounter = 0;
// map of each connection and if ready true/false
var connStatus = {};
// a map of each component ID to it's object
var componentIdx = {};
// for async calls to the worker, maintains the callback to execute with the result, when applicable
var callbackRegistry = {};

var fqlWorker = new Worker("/fqlClient.js");

fqlWorker.onmessage = function(e) {
    const msg = e.data;
    console.log("Worker received message: " + JSON.stringify(msg));

    switch (msg.event) {
        case "connReady":
            connStatus[msg.conn] = true;
            return;
        case "setState":
            const comp = componentIdx[msg.ref];
            if (comp) {
                comp.setState(msg.data);
            } else {
                console.warn("Component no longer registered: " + msg.ref);
            }
            return;
        case "remoteInvoke":
            // check for a callback 
            const cb = callbackRegistry[msg.ref];
            if (cb) {
                delete callbackRegistry[msg.ref];
                cb(msg.data);
            }
            return;
        default:
            console.warn("Unreconized event from worker: " + msg.event + ". Full message: " + JSON.stringify(msg));
    }
}


function setStateCb(conn, id, stateUpdate) {

    const comp = componentIdx[id];

    if (comp) {
        comp.setState(stateUpdate);
    } else {
        console.warn("Component no longer registered: " + compId);
    }
}

// we use a global to track connection state, get method for it
function isReady(connId) {
    return connStatus[connId];
}


function workerInvoke(obj) {
    if (obj.cb) {
        obj.ref = obj.ref || nextId();
        callbackRegistry[obj.ref] = obj.cb;
        delete obj.cb;
    }
    fqlWorker.postMessage(obj);
    return true;
}

// Register a query, provide the connection, component ID, query and query options
export function registerQuery(conn, compId, query, opts) {
    const invokeObj = {
        conn: conn.id,
        action: "registerQuery",
        ref: compId,
        params: [compId, query, null]
        };
    return workerInvoke(invokeObj);
}

// Remove query from registry
export function unregisterQuery(conn, compId) {
    workerInvoke({
        conn: conn.id,
        ref:    compId,
        action: "unregisterQuery",
        params: [compId]
        })
}

// Create a new connection with settings object.
// need to provide url, instance and token keys at minumumb.
export function ReactConnect(settings) {

    connIdCounter++;

    const connId = connIdCounter;

    const baseSetting = {
        id: connId,
        removeNamespace: true // by default remove namespace from results
        };

    const s = Object.assign(baseSetting, settings);

    const conn = {
        id: connId,
        isReady: () => isReady(connId),
        invoke: function(action, params, cb) { 
                    const invokeStatment = [action, params];
                    return workerInvoke({
                        conn: connId, 
                        action: "remoteInvoke", 
                        params: [invokeStatment],
                        cb: cb
                    }); 
                }
    }

    // initiate our connection in the web worker
    workerInvoke({
        conn: 0, // conn 0 means not connection specific
        action: "connect",
        params: [s]
    })

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
        return React.Children.only(this.props.children);
    };
}


// given a query and options, returns a vector of variables that 
// were not provided via options. We use this to look for the variables 
// in props
function getMissingVars(flurQL, opts) {

    const vars = flurQL.vars;

    if (Array.isArray(vars)) {
        if (opts && opts.vars) {
            return vars.filter( (v) => { return !opts.vars[v]})
        } else {
            return vars;
        }
    } else {
        return [];
    }
}


function wrapComponent(WrappedComponent, query, opts) {

    const flurQLDisplayName = `Fluree(${getDisplayName(WrappedComponent)})`;

    class FlurQL extends Component {
        static displayName = getDisplayName;
        static WrappedComponent = WrappedComponent;
        static contextTypes = {
            conn: PropTypes.object.isRequired
        };

        constructor(props, context) {
            super(props, context);
            this.conn = context.conn;
            this.opts = Object.assign({vars: {}}, opts);
            this.id = nextId();
            this.missingVars = getMissingVars(query, this.opts); // list of vars we need to check props for
            this.state = {
                result: null,
                error: null,
                warning: null,
                status: null,
                loading: null
            };

            if (!this.conn) {
                throw "Could not find a Fluree connection (conn) in the context of " + flurQLDisplayName + ".";
            }
        }

        componentWillMount() {
            // get any missing vars from props and update this.opts with them
            if (this.missingVars.length !== 0) {
                this.missingVars.map( (v) => { this.opts.vars[v] = this.props[v] });
            }

            // register this component for later re-render calling, etc.
            componentIdx[this.id] = this;

            registerQuery(this.conn, this.id, query, this.opts);

        }

        componentWillUnmount() {

            unregisterQuery(this.conn, this.id);
            delete componentIdx[this.id];

        }

        componentWillReceiveProps(nextProps) {
            // check if any of the missing vars changed with the new props
            let didMissingVarsChange = false;

            for (let i = 0; i < this.missingVars.length; i++) {
                const varName = this.missingVars[i];
                if (this.props[varName] !== nextProps[varName]) {
                    didMissingVarsChange = true;
                }
            }

            if (didMissingVarsChange === true) {
                this.missingVars.map( (v) => { 
                    this.opts.vars[v] = nextProps[v];
                    return;
                });
                registerQuery(this.conn, this.id, query, this.opts);
            }
        }

        render() {
            const isLoading = this.state.status && this.state.status !== "loaded";
            const data = {
                id: this.id,
                result: this.state.result,
                error: this.state.error,
                warning: this.state.warning,
                status: this.state.status,
                loading: isLoading
            };

            const childProps = Object.assign( {}, this.props, {data: data, invoke: this.conn.invoke});

            return createElement(WrappedComponent, childProps);
        }
    }

    return hoistNonReactStatics(FlurQL, WrappedComponent, {});
}


export function flureeQL(query, opts) {
    return function(WrappedComponent) {
        return wrapComponent(WrappedComponent, query, opts);
    }
}

