import assert from 'assert';
import { expect } from 'chai';
import Tracker from './lib/index.js';

describe('basics', () => {
  it("should be defined", () => {
    assert.equal( typeof Tracker, "function", "Tracker is defined" );
    assert.equal( typeof Tracker.Computation, "function", "Tracker.Computation" );
    assert.equal( typeof Tracker.Dependency, "function", "Tracker.Dependency" );
    assert.equal( typeof Tracker.flush, "function", "Tracker.flush" );
    assert.equal( typeof Tracker._runFlush, "function", "Tracker._runFlush" );
    assert.equal( typeof Tracker.autorun, "function", "Tracker.autorun" );
    assert.equal( typeof Tracker.nonreactive, "function", "Tracker.nonreactive" );
    assert.equal( typeof Tracker.onInvalidate, "function", "Tracker.onInvalidate" );
    assert.equal( typeof Tracker.afterFlush, "function", "Tracker.afterFlush" );
  });

  it("tracker - run", () => {
    let d = new Tracker.Dependency;

    let x = 0;
    let handle = Tracker.autorun(function (handle) {
      d.depend();
      ++x;
    });

    assert.equal( x, 1 );
    Tracker.flush();
    assert.equal( x, 1 );
    d.changed();
    assert.equal( x, 1 );
    Tracker.flush();
    assert.equal( x, 2 );
    d.changed();
    assert.equal( x, 2 );
    Tracker.flush();
    assert.equal( x, 3 );
    d.changed();
    // Prevent the function from running further.
    handle.stop();
    Tracker.flush();
    assert.equal( x, 3 );
    d.changed();
    Tracker.flush();
    assert.equal( x, 3 );

    Tracker.autorun(function (internalHandle) {
      d.depend();
      ++x;
      if (x == 6)
        internalHandle.stop();
    });

    assert.equal( x, 4 );
    d.changed();
    Tracker.flush();
    assert.equal( x, 5 );
    d.changed();
    // Increment to 6 and stop.
    Tracker.flush();
    assert.equal( x, 6 );
    d.changed();
    Tracker.flush();
    // Still 6!
    assert.equal( x, 6 );

    assert.throws(function () {
      Tracker.autorun();
    });
    assert.throws(function () {
      Tracker.autorun({});
    });
  });

  it("tracker - nested run", () => {
    let a = new Tracker.Dependency;
    let b = new Tracker.Dependency;
    let c = new Tracker.Dependency;
    let d = new Tracker.Dependency;
    let e = new Tracker.Dependency;
    let f = new Tracker.Dependency;

    let buf = "";

    let c1 = Tracker.autorun(function () {
      a.depend();
      buf += 'a';
      Tracker.autorun(function () {
        b.depend();
        buf += 'b';
        Tracker.autorun(function () {
          c.depend();
          buf += 'c';
          let c2 = Tracker.autorun(function () {
            d.depend();
            buf += 'd';
            Tracker.autorun(function () {
              e.depend();
              buf += 'e';
              Tracker.autorun(function () {
                f.depend();
                buf += 'f';
              });
            });
            Tracker.onInvalidate(function () {
              // only run once
              c2.stop();
            });
          });
        });
      });
      Tracker.onInvalidate(function (c1) {
        c1.stop();
      });
    });

    let expect = function (str) {
      assert.equal( buf, str );
      buf = "";
    };

    expect('abcdef');

    b.changed();
    expect(''); // didn't flush yet
    Tracker.flush();
    expect('bcdef');

    c.changed();
    Tracker.flush();
    expect('cdef');

    let changeAndExpect = function (v, str) {
      v.changed();
      Tracker.flush();
      expect(str);
    };

    // should cause running
    changeAndExpect(e, 'ef');
    changeAndExpect(f, 'f');
    // invalidate inner context
    changeAndExpect(d, '');
    // no more running!
    changeAndExpect(e, '');
    changeAndExpect(f, '');
    // rerun C
    changeAndExpect(c, 'cdef');
    changeAndExpect(e, 'ef');
    changeAndExpect(f, 'f');
    // rerun B
    changeAndExpect(b, 'bcdef');
    changeAndExpect(e, 'ef');
    changeAndExpect(f, 'f');
    // kill A
    a.changed();
    changeAndExpect(f, '');
    changeAndExpect(e, '');
    changeAndExpect(d, '');
    changeAndExpect(c, '');
    changeAndExpect(b, '');
    changeAndExpect(a, '');

    assert.ok( ! a.hasDependents());
    assert.ok( ! b.hasDependents());
    assert.ok( ! c.hasDependents());
    assert.ok( ! d.hasDependents());
    assert.ok( ! e.hasDependents());
    assert.ok( ! f.hasDependents());
  });

  it("tracker - flush", () => {
    let buf = "";

    let c1 = Tracker.autorun(function (c) {
      buf += 'a';
      // invalidate first time
      if (c.firstRun)
        c.invalidate();
    });

    assert.equal(buf, 'a');
    Tracker.flush();
    assert.equal(buf, 'aa');
    Tracker.flush();
    assert.equal(buf, 'aa');
    c1.stop();
    Tracker.flush();
    assert.equal(buf, 'aa');

    //////

    buf = "";

    let c2 = Tracker.autorun(function (c) {
      buf += 'a';
      // invalidate first time
      if (c.firstRun)
        c.invalidate();

      Tracker.onInvalidate(function () {
        buf += "*";
      });
    });

    assert.equal(buf, 'a*');
    Tracker.flush();
    assert.equal(buf, 'a*a');
    c2.stop();
    assert.equal(buf, 'a*a*');
    Tracker.flush();
    assert.equal(buf, 'a*a*');

    /////
    // Can flush a diferent run from a run;
    // no current computation in afterFlush

    buf = "";

    let c3 = Tracker.autorun(function (c) {
      buf += 'a';
      // invalidate first time
      if (c.firstRun)
        c.invalidate();
      Tracker.afterFlush(function () {
        buf += (Tracker.active ? "1" : "0");
      });
    });

    Tracker.afterFlush(function () {
      buf += 'c';
    });

    let c4 = Tracker.autorun(function (c) {
      c4 = c;
      buf += 'b';
    });

    Tracker.flush();
    assert.equal(buf, 'aba0c0');
    c3.stop();
    c4.stop();
    Tracker.flush();

    // cases where flush throws

    let ran = false;
    Tracker.afterFlush(function (arg) {
      ran = true;
      assert.equal(typeof arg, 'undefined');
      assert.throws(function () {
        Tracker.flush(); // illegal nested flush
      });
    });

    Tracker.flush();
    assert.ok(ran);

    assert.throws(function () {
      Tracker.autorun(function () {
        Tracker.flush(); // illegal to flush from a computation
      });
    });

    assert.throws(function () {
      Tracker.autorun(function () {
        Tracker.autorun(function () {});
        Tracker.flush();
      });
    });
  });

  it("tracker - lifecycle", () => {
    assert.ok( ! Tracker.active );
    assert.equal( null, Tracker.currentComputation );

    let runCount = 0;
    let firstRun = true;
    let buf = [];
    let cbId = 1;
    let makeCb = function () {
      let id = cbId++;
      return function () {
        buf.push(id);
      };
    };

    let shouldStop = false;

    let c1 = Tracker.autorun(function (c) {
      assert.ok( Tracker.active );
      assert.equal( c, Tracker.currentComputation );
      assert.equal( c.stopped, false );
      assert.equal( c.invalidated, false );
      assert.equal( c.firstRun, firstRun );

      Tracker.onInvalidate(makeCb()); // 1, 6, ...
      Tracker.afterFlush(makeCb()); // 2, 7, ...

      Tracker.autorun(function (x) {
        x.stop();
        c.onInvalidate(makeCb()); // 3, 8, ...

        Tracker.onInvalidate(makeCb()); // 4, 9, ...
        Tracker.afterFlush(makeCb()); // 5, 10, ...
      });
      runCount++;

      if (shouldStop)
        c.stop();
    });

    firstRun = false;

    assert.equal(runCount, 1);

    assert.deepEqual(buf, [4]);
    c1.invalidate();
    assert.equal(runCount, 1);
    assert.equal(c1.invalidated, true);
    assert.equal(c1.stopped, false);
    assert.deepEqual(buf, [4, 1, 3]);

    Tracker.flush();

    assert.equal(runCount, 2);
    assert.equal(c1.invalidated, false);
    assert.deepEqual(buf, [4, 1, 3, 9, 2, 5, 7, 10]);

    // assert self-stop
    buf.length = 0;
    shouldStop = true;
    c1.invalidate();
    assert.deepEqual(buf, [6, 8]);
    Tracker.flush();
    assert.deepEqual(buf, [6, 8, 14, 11, 13, 12, 15]);
  });

  it("tracker - onInvalidate", () => {
    let buf = "";

    let c1 = Tracker.autorun(function () {
      buf += "*";
    });

    let append = function (x, expectedComputation) {
      return function (givenComputation) {
        assert.ok( ! Tracker.active);
        assert.equal(givenComputation, expectedComputation || c1);
        buf += x;
      };
    };

    c1.onStop(append('s'));

    c1.onInvalidate(append('a'));
    c1.onInvalidate(append('b'));
    assert.equal(buf, '*');
    Tracker.autorun(function (me) {
      Tracker.onInvalidate(append('z', me));
      me.stop();
      assert.equal(buf, '*z');
      c1.invalidate();
    });
    assert.equal(buf, '*zab');
    c1.onInvalidate(append('c'));
    c1.onInvalidate(append('d'));
    assert.equal(buf, '*zabcd');
    Tracker.flush();
    assert.equal(buf, '*zabcd*');

    // afterFlush ordering
    buf = '';
    c1.onInvalidate(append('a'));
    c1.onInvalidate(append('b'));
    Tracker.afterFlush(function () {
      append('x')(c1);
      c1.onInvalidate(append('c'));
      c1.invalidate();
      Tracker.afterFlush(function () {
        append('y')(c1);
        c1.onInvalidate(append('d'));
        c1.invalidate();
      });
    });
    Tracker.afterFlush(function () {
      append('z')(c1);
      c1.onInvalidate(append('e'));
      c1.invalidate();
    });

    assert.equal(buf, '');
    Tracker.flush();
    assert.equal(buf, 'xabc*ze*yd*');

    buf = "";
    c1.onInvalidate(append('m'));
    Tracker.flush();
    assert.equal(buf, '');
    c1.stop();
    assert.equal(buf, 'ms');  // s is from onStop
    Tracker.flush();
    assert.equal(buf, 'ms');
    c1.onStop(append('S'));
    assert.equal(buf, 'msS');
  });

  it("tracker - invalidate at flush time", () => {
    // Test this sentence of the docs: Functions are guaranteed to be
    // called at a time when there are no invalidated computations that
    // need rerunning.

    let buf = [];

    Tracker.afterFlush(function () {
      buf.push('C');
    });

    // When c1 is invalidated, it invalidates c2, then stops.
    let c1 = Tracker.autorun(function (c) {
      if (! c.firstRun) {
        buf.push('A');
        c2.invalidate();
        c.stop();
      }
    });

    let c2 = Tracker.autorun(function (c) {
      if (! c.firstRun) {
        buf.push('B');
        c.stop();
      }
    });

    // Invalidate c1.  If all goes well, the re-running of
    // c2 should happen before the afterFlush.
    c1.invalidate();
    Tracker.flush();

    assert.equal(buf.join(''), 'ABC');
  });

  it("tracker - throwFirstError", () => {
    let d = new Tracker.Dependency;
    Tracker.autorun(function (c) {
      d.depend();

      if (!c.firstRun)
        throw new Error("foo");
    });

    // d.changed();
    // // doesn't throw; logs instead.
    // Meteor._suppress_log(1);
    // Tracker.flush();

    d.changed();
    assert.throws(function () {
      Tracker.flush({_throwFirstError: true});
    }, /foo/);
  });

  it("tracker - no infinite recomputation", () => {
    let reran = false;
    let c = Tracker.autorun(function (c) {
      if (! c.firstRun)
        reran = true;
      c.invalidate();
    });
    assert.ok( ! reran);
    // Meteor.setTimeout(function () {
    beforeEach(function(done) {
      setTimeout(function () {
        c.stop();
        Tracker.afterFlush(function () {
          assert.ok(reran);
          assert.ok(c.stopped);

          // complete the async beforeEach
          done();
        });
      }, 100);
    });
  });

  it("tracker - Tracker.flush finishes", () => {
    // Currently, _runFlush will "yield" every 1000 computations... unless run in
    // Tracker.flush. So this test validates that Tracker.flush is capable of
    // running 2000 computations. Which isn't quite the same as infinity, but it's
    // getting there.
    let n = 0;
    let c = Tracker.autorun(function (c) {
      if (++n < 2000) {
        c.invalidate();
      }
    });
    assert.equal(n, 1);
    Tracker.flush();
    assert.equal(n, 2000);
  });

  it("tracker - Tracker.autorun, onError option", () => {
    let d = new Tracker.Dependency;
    beforeEach(function(done) {
      let c = Tracker.autorun(function (c) {
        d.depend();

        if (! c.firstRun)
          throw new Error("foo");
      }, function (err) {
        assert.equal(err.message, "foo");
        done();
      });
    });

    d.changed();
    Tracker.flush();
  });
});
