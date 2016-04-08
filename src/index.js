export default class Tracker {
  static active = false;
  static currentComputation = null;
  static _computations = {};

  /**
  * @summary A Computation object represents code that is repeatedly rerun
  * in response to
  * reactive data changes. Computations don't have return values; they just
  * perform actions, such as rerendering a template on the screen. Computations
  * are created using Tracker.autorun. Use stop to prevent further rerunning of a
  * computation.
  * @instancename computation
  */
  static Computation = class Computation {
    constructor(f, parent, onError) {
      if (! constructingComputation)
      throw new Error("Tracker.Computation constructor is private; use Tracker.autorun");
      constructingComputation = false;

      let self = this;

      // http://docs.meteor.com/#computation_stopped

      /**
      * @summary True if this computation has been stopped.
      * @locus Client
      * @memberOf Tracker.Computation
      * @instance
      * @name  stopped
      */
      self.stopped = false;
      // http://docs.meteor.com/#computation_invalidated

      /**
      * @summary True if this computation has been invalidated (and not yet rerun), or if it has been stopped.
      * @locus Client
      * @memberOf Tracker.Computation
      * @instance
      * @name  invalidated
      * @type {Boolean}
      */
      self.invalidated = false;
      // http://docs.meteor.com/#computation_firstrun

      /**
      * @summary True during the initial run of the computation at the time `Tracker.autorun` is called, and false on subsequent reruns and at other times.
      * @locus Client
      * @memberOf Tracker.Computation
      * @instance
      * @name  firstRun
      * @type {Boolean}
      */
      self.firstRun = true;

      self._id = nextId++;
      self._onInvalidateCallbacks = [];
      self._onStopCallbacks = [];
      // the plan is at some point to use the parent relation
      // to constrain the order that computations are processed
      self._parent = parent;
      self._func = f;
      self._onError = onError;
      self._recomputing = false;

      // Register the computation within the global Tracker.
      Tracker._computations[self._id] = self;

      var errored = true;
      try {
        self._compute();
        errored = false;
      } finally {
        self.firstRun = false;
        if (errored)
        self.stop();
      }
    }

    /**
     * @summary Registers `callback` to run when this computation is next invalidated, or runs it immediately if the computation is already invalidated.  The callback is run exactly once and not upon future invalidations unless `onInvalidate` is called again after the computation becomes valid again.
     * @locus Client
     * @param {Function} callback Function to be called on invalidation. Receives one argument, the computation that was invalidated.
     */
    onInvalidate(f) {
      let self = this;

      if (typeof f !== 'function')
        throw new Error("onInvalidate requires a function");

      if (self.invalidated) {
        Tracker.nonreactive(function () {
          withNoYieldsAllowed(f)(self);
        });
      } else {
        self._onInvalidateCallbacks.push(f);
      }
    }

    /**
     * @summary Registers `callback` to run when this computation is stopped, or runs it immediately if the computation is already stopped.  The callback is run after any `onInvalidate` callbacks.
     * @locus Client
     * @param {Function} callback Function to be called on stop. Receives one argument, the computation that was stopped.
     */
    onStop(f) {
      let self = this;

      if (typeof f !== 'function')
        throw new Error("onStop requires a function");

      if (self.stopped) {
        Tracker.nonreactive(function () {
          withNoYieldsAllowed(f)(self);
        });
      } else {
        self._onStopCallbacks.push(f);
      }
    }

    /**
     * @summary Invalidates this computation so that it will be rerun.
     * @locus Client
     */
    invalidate() {
      var self = this;
      if (! self.invalidated) {
        // if we're currently in _recompute(), don't enqueue
        // ourselves, since we'll rerun immediately anyway.
        if (! self._recomputing && ! self.stopped) {
          requireFlush();
          pendingComputations.push(this);
        }

        self.invalidated = true;

        // callbacks can't add callbacks, because
        // self.invalidated === true.
        for(var i = 0, f; f = self._onInvalidateCallbacks[i]; i++) {
          Tracker.nonreactive(function () {
            withNoYieldsAllowed(f)(self);
          });
        }
        self._onInvalidateCallbacks = [];
      }
    }

    stop() {
      let self = this;

      if (! self.stopped) {
        self.stopped = true;
        self.invalidate();
        // Unregister from global Tracker.
        delete Tracker._computations[self._id];
        for(let i = 0, f; f = self._onStopCallbacks[i]; i++) {
          Tracker.nonreactive(function () {
            withNoYieldsAllowed(f)(self);
          });
        }
        self._onStopCallbacks = [];
      }
    }

    _compute() {
      let self = this;
      self.invalidated = false;

      let previous = Tracker.currentComputation;
      setCurrentComputation(self);
      let previousInCompute = inCompute;
      inCompute = true;
      try {
        withNoYieldsAllowed(self._func)(self);
      } finally {
        setCurrentComputation(previous);
        inCompute = previousInCompute;
      }
    }

    _needsRecompute() {
      let self = this;
      return self.invalidated && ! self.stopped;
    }

    _recompute() {
      let self = this;

      console.log(self);

      self._recomputing = true;
      try {
        if (self._needsRecompute()) {
          try {
            self._compute();
          } catch (e) {
            if (self._onError) {
              self._onError(e);
            } else {
              _throwOrLog("recompute", e);
            }
          }
        }
      } finally {
        self._recomputing = false;
      }
    }
  }

  static Dependency = class Dependency {
    constructor() {
      this._dependentsById = {};
    }

    depend = function (computation) {
      if (! computation) {
        if (! Tracker.active)
          return false;

        computation = Tracker.currentComputation;
      }
      let self = this;
      let id = computation._id;
      if (! (id in self._dependentsById)) {
        self._dependentsById[id] = computation;
        computation.onInvalidate(function () {
          delete self._dependentsById[id];
        });
        return true;
      }
      return false;
    }

    changed = function () {
      let self = this;
      for (let id in self._dependentsById)
        self._dependentsById[id].invalidate();
    }

    hasDependents = function () {
      let self = this;
      for(let id in self._dependentsById)
        return true;
      return false;
    }
  }

  static flush(options) {
    Tracker._runFlush({ finishSynchronously: true,
                        throwFirstError: options && options._throwFirstError });
  }

  static _runFlush(options) {
    // XXX What part of the comment below is still true? (We no longer
    // have Spark)
    //
    // Nested flush could plausibly happen if, say, a flush causes
    // DOM mutation, which causes a "blur" event, which runs an
    // app event handler that calls Tracker.flush.  At the moment
    // Spark blocks event handlers during DOM mutation anyway,
    // because the LiveRange tree isn't valid.  And we don't have
    // any useful notion of a nested flush.
    //
    // https://app.asana.com/0/159908330244/385138233856
    if (inFlush)
      throw new Error("Can't call Tracker.flush while flushing");

    if (inCompute)
      throw new Error("Can't flush inside Tracker.autorun");

    options = options || {};

    inFlush = true;
    willFlush = true;
    throwFirstError = !! options.throwFirstError;

    var recomputedCount = 0;
    var finishedTry = false;
    try {
      while (pendingComputations.length ||
             afterFlushCallbacks.length) {

        // recompute all pending computations
        while (pendingComputations.length) {
          var comp = pendingComputations.shift();
          comp._recompute();
          if (comp._needsRecompute()) {
            pendingComputations.unshift(comp);
          }

          if (! options.finishSynchronously && ++recomputedCount > 1000) {
            finishedTry = true;
            return;
          }
        }

        if (afterFlushCallbacks.length) {
          // call one afterFlush callback, which may
          // invalidate more computations
          var func = afterFlushCallbacks.shift();
          try {
            func();
          } catch (e) {
            _throwOrLog("afterFlush", e);
          }
        }
      }
      finishedTry = true;
    } finally {
      if (! finishedTry) {
        // we're erroring due to throwFirstError being true.
        inFlush = false; // needed before calling `Tracker.flush()` again
        // finish flushing
        Tracker._runFlush({
          finishSynchronously: options.finishSynchronously,
          throwFirstError: false
        });
      }
      willFlush = false;
      inFlush = false;
      if (pendingComputations.length || afterFlushCallbacks.length) {
        // We're yielding because we ran a bunch of computations and we aren't
        // required to finish synchronously, so we'd like to give the event loop a
        // chance. We should flush again soon.
        if (options.finishSynchronously) {
          throw new Error("still have more to do?");  // shouldn't happen
        }
        setTimeout(requireFlush, 10);
      }
    }
  }

  static autorun(f, options) {
    if (typeof f !== 'function')
      throw new Error('Tracker.autorun requires a function argument');

    options = options || {};

    constructingComputation = true;
    var c = new Tracker.Computation(
      f, Tracker.currentComputation, options.onError);

    if (Tracker.active)
      Tracker.onInvalidate(function () {
        c.stop();
      });

    return c;
  }

  static nonreactive(f) {
    var previous = Tracker.currentComputation;
    setCurrentComputation(null);
    try {
      return f();
    } finally {
      setCurrentComputation(previous);
    }
  }

  static onInvalidate(f) {
    if (! Tracker.active)
      throw new Error("Tracker.onInvalidate requires a currentComputation");

    Tracker.currentComputation.onInvalidate(f);
  }

  static afterFlush(f) {
    afterFlushCallbacks.push(f);
    requireFlush();
  }
}

const withNoYieldsAllowed = function (f) {
  if ((typeof Meteor === 'undefined') || Meteor.isClient) {
    return f;
  } else {
    return function () {
      let args = arguments;
      Meteor._noYieldsAllowed(function () {
        f.apply(null, args);
      });
    };
  }
};

const setCurrentComputation = function (c) {
  Tracker.currentComputation = c;
  Tracker.active = !! c;
};

const _debugFunc = function () {
  // We want this code to work without Meteor, and also without
  // "console" (which is technically non-standard and may be missing
  // on some browser we come across, like it was on IE 7).
  //
  // Lazy evaluation because `Meteor` does not exist right away.(??)
  return (typeof Meteor !== "undefined" ? Meteor._debug :
  ((typeof console !== "undefined") && console.error ?
  function () { console.error.apply(console, arguments); } :
  function () {}));
};

const _maybeSuppressMoreLogs = function (messagesLength) {
  // Sometimes when running tests, we intentionally suppress logs on expected
  // printed errors. Since the current implementation of _throwOrLog can log
  // multiple separate log messages, suppress all of them if at least one suppress
  // is expected as we still want them to count as one.
  if (typeof Meteor !== "undefined") {
    if (Meteor._suppressed_log_expected()) {
      Meteor._suppress_log(messagesLength - 1);
    }
  }
}

const _throwOrLog = function (from, e) {
  if (throwFirstError) {
    throw e;
  } else {
    let printArgs = ["Exception from Tracker " + from + " function:"];
    if (e.stack && e.message && e.name) {
      let idx = e.stack.indexOf(e.message);
      if (idx < 0 || idx > e.name.length + 2) { // check for "Error: "
      // message is not part of the stack
      let message = e.name + ": " + e.message;
      printArgs.push(message);
    }
  }
  printArgs.push(e.stack);
  _maybeSuppressMoreLogs(printArgs.length);

  for (let i = 0; i < printArgs.length; i++) {
    _debugFunc()(printArgs[i]);
  }
}
};

let nextId = 1;
// computations whose callbacks we should call at flush time
let pendingComputations = [];
// `true` if a Tracker.flush is scheduled, or if we are in Tracker.flush now
let willFlush = false;
// `true` if we are in Tracker.flush now
let inFlush = false;
// `true` if we are computing a computation now, either first time
// or recompute.  This matches Tracker.active unless we are inside
// Tracker.nonreactive, which nullfies currentComputation even though
// an enclosing computation may still be running.
let inCompute = false;
// `true` if the `_throwFirstError` option was passed in to the call
// to Tracker.flush that we are in. When set, throw rather than log the
// first error encountered while flushing. Before throwing the error,
// finish flushing (from a finally block), logging any subsequent
// errors.
let throwFirstError = false;

let afterFlushCallbacks = [];

// Tracker.Computation constructor is visible but private
// (throws an error if you try to call it)
let constructingComputation = false;

const requireFlush = function () {
  if (! willFlush) {
    // We want this code to work without Meteor, see debugFunc above
    if (typeof Meteor !== "undefined")
    Meteor._setImmediate(Tracker._runFlush);
    else
    setTimeout(Tracker._runFlush, 0);
    willFlush = true;
  }
};
