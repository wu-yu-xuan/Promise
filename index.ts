function isPromiseLike<T>(x: any): x is PromiseLike<T> {
  return (
    x instanceof PromisePolyfill ||
    (x !== null &&
      (typeof x === 'object' || typeof x === 'function') &&
      'then' in x &&
      typeof x.then === 'function')
  );
}

/**
 * 2.1: A promise must be in one of three states: pending, fulfilled, or rejected.
 */
enum PromiseStatus {
  pending,
  resolved,
  rejected
}

/**
 * @see https://promisesaplus.com/
 */
export default class PromisePolyfill<T, Reason = any>
  implements PromiseLike<T> {
  static resolve<T>(value: T | PromiseLike<T>): PromisePolyfill<T> {
    return new PromisePolyfill(resolve => resolve(value));
  }
  static reject<T = never>(reason?: any): PromisePolyfill<T> {
    return new PromisePolyfill((_, reject) => reject(reason));
  }
  static race<T>(values: Iterable<T | PromiseLike<T>>): PromisePolyfill<T> {
    /**
     * why it works?
     * 2.1: When fulfilled or rejected, a promise must not transition to any other state
     * and must have a value, which must not change.
     * 2.2: onFulfilled or onRejected must not be called more than once.
     */
    return new PromisePolyfill((resolve, reject) => {
      for (const iterator of values) {
        PromisePolyfill.resolve(iterator).then(
          value => resolve(value),
          reason => reject(reason)
        );
      }
    });
  }
  static all<T>(values: Iterable<T | PromiseLike<T>>): PromisePolyfill<T[]> {
    return new PromisePolyfill((resolve, reject) => {
      let resolvedCount = 0;
      let length = 0;
      const result: T[] = [];
      for (const iterator of values) {
        const index = length;
        length++;
        PromisePolyfill.resolve(iterator).then(
          value => {
            resolvedCount++;
            result[index] = value;
            if (resolvedCount === length) {
              resolve(result);
            }
          },
          reason => reject(reason)
        );
      }
    });
  }
  static deferred() {
    const result: any = {};
    result.promise = new PromisePolyfill((resolve, reject) => {
      result.resolve = resolve;
      result.reject = reject;
    });
    return result;
  }
  private value?: T;
  private reason?: Reason;
  private status: PromiseStatus = PromiseStatus.pending;
  private resolveCallbacks: Array<(value: T) => void> = [];
  private rejectCallbacks: Array<(reason: Reason) => void> = [];
  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason: Reason) => void
    ) => void
  ) {
    const self = this;
    function resolve(value: T | PromiseLike<T>) {
      if (isPromiseLike<T>(value)) {
        value.then(resolve, reject);
        return;
      }
      setTimeout(() => {
        if (self.status === PromiseStatus.pending) {
          self.status = PromiseStatus.resolved;
          self.value = value;
          self.resolveCallbacks.forEach(cb => cb(value));
        }
      });
    }
    function reject(reason: Reason) {
      setTimeout(() => {
        if (self.status === PromiseStatus.pending) {
          self.status = PromiseStatus.rejected;
          self.reason = reason;
          self.rejectCallbacks.forEach(cb => cb(reason));
        }
      });
    }
    try {
      executor(resolve, reject);
    } catch (error) {
      reject(error);
    }
  }
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?:
      | ((value: T) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: Reason) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null
  ): PromisePolyfill<TResult1, TResult2> {
    /**
     * 2.2.1: Both onFulfilled and onRejected are optional arguments:
     * 2.2.1.1: If onFulfilled is not a function, it must be ignored.
     * 2.2.1.2: If onRejected is not a function, it must be ignored.
     * 2.2.7.3: If onFulfilled is not a function and promise1 is fulfilled,
     * promise2 must be fulfilled with the same value as promise1.
     * 2.2.7.4: If onRejected is not a function and promise1 is rejected,
     * promise2 must be rejected with the same reason as promise1.
     */
    const onFulfilled =
      typeof onfulfilled === 'function' ? onfulfilled : (value: T) => value;
    const onRejected =
      typeof onrejected === 'function'
        ? onrejected
        : (reason: Reason) => {
            throw reason;
          };

    /**
     * 2.2.7: then must return a promise
     */
    let promise: PromisePolyfill<TResult1, TResult2>;

    function makeResolve(
      resolve: (value: TResult1 | PromiseLike<TResult1>) => void,
      reject: (reason: TResult2) => void,
      handler:
        | ((value: T) => TResult1 | PromiseLike<TResult1>)
        | ((value: T) => T)
        | ((reason: Reason) => TResult2 | PromiseLike<TResult2>)
    ) {
      return (value: T | Reason) => {
        try {
          const x = handler(value as T & Reason);
          promise.resolveProcedure(x, resolve, reject);
        } catch (e) {
          reject(e);
        }
      };
    }

    switch (this.status) {
      case PromiseStatus.pending:
        return (promise = new PromisePolyfill((resolve, reject) => {
          this.resolveCallbacks.push(makeResolve(resolve, reject, onFulfilled));
          this.rejectCallbacks.push(makeResolve(resolve, reject, onRejected));
        }));
      case PromiseStatus.resolved:
        return (promise = new PromisePolyfill((resolve, reject) => {
          setTimeout(() =>
            makeResolve(resolve, reject, onFulfilled)(this.value!)
          );
        }));
      case PromiseStatus.rejected:
        return (promise = new PromisePolyfill((resolve, reject) => {
          setTimeout(() =>
            makeResolve(resolve, reject, onRejected)(this.reason!)
          );
        }));
      default:
        throw new Error(`unsupported status: ${this.status}`);
    }
  }
  catch<TResult = never>(
    onrejected?:
      | ((reason: Reason) => TResult | PromiseLike<TResult>)
      | undefined
      | null
  ): PromisePolyfill<T | TResult> {
    return this.then(null, onrejected);
  }

  /**
   * @see https://tc39.es/ecma262/#sec-promise.prototype.finally
   * When creating a function inline, you can pass it once,
   * instead of being forced to either declare it twice, or create a variable for it
   * A finally callback will not receive any argument,
   * since there's no reliable means of determining if the promise was fulfilled or rejected.
   * This use case is for precisely when you do not care about the rejection reason,
   * or the fulfillment value, and so there's no need to provide it.
   * So for example:
   * Unlike Promise.resolve(2).then(() => {}, () => {}) (which will be resolved with undefined),
   * Promise.resolve(2).finally(() => {}) will be resolved with 2.
   * Similarly, unlike Promise.reject(3).then(() => {}, () => {}) (which will be fulfilled with undefined),
   * Promise.reject(3).finally(() => {}) will be rejected with 3.
   */
  finally(onfinally?: (() => void) | undefined | null): PromisePolyfill<T> {
    return this.then(
      value => {
        if (onfinally) {
          onfinally();
        }
        return value;
      },
      reason => {
        if (onfinally) {
          onfinally();
        }
        return reason;
      }
    );
  }

  /**
   * 2.3: The Promise Resolution Procedure
   * The promise resolution procedure is an abstract operation taking as input a promise and a value,
   * which we denote as [[Resolve]](promise, x).
   * If x is a thenable,
   * it attempts to make promise adopt the state of x,
   * under the assumption that x behaves at least somewhat like a promise.
   * Otherwise, it fulfills promise with the value x.
   * This treatment of thenables allows promise implementations to interoperate,
   * as long as they expose a Promises/A+-compliant then method.
   * It also allows Promises/A+ implementations to “assimilate” nonconformant implementations with reasonable then methods.
   * @see https://promisesaplus.com/#the-promise-resolution-procedure
   */
  private resolveProcedure(
    x: any,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason: any) => void
  ) {
    /**
     * 2.3.1: If promise and x refer to the same object, reject promise with a TypeError as the reason.
     */
    if (this === x) {
      return reject(new TypeError('cycle detected'));
    }

    /**
     * 2.3.2: If x is a promise, adopt its state
     */
    if (x instanceof PromisePolyfill) {
      return x.then(resolve, reject);
    }

    /**
     * 2.3.3: Otherwise, if x is an object or function
     */
    if (x !== null && (typeof x === 'object' || typeof x === 'function')) {
      let then;
      try {
        /**
         * 2.3.3.1: Let then be x.then.
         */
        then = x.then;
      } catch (e) {
        /**
         * 2.3.3.2: If retrieving the property x.then results in a thrown exception e,
         * reject promise with e as the reason.
         */
        return reject(e);
      }

      if (typeof then === 'function') {
        /**
         * 2.3.3.3.3: If both resolvePromise and rejectPromise are called,
         * or multiple calls to the same argument are made,
         * the first call takes precedence, and any further calls are ignored.
         */
        let runned = false;
        try {
          /**
           * 2.3.3.3: If then is a function, call it with x as this,
           * first argument resolvePromise, and second argument rejectPromise, where:
           */
          return then.call(
            x,
            (y: any) => {
              if (runned) {
                return;
              }
              runned = true;
              /**
               * 2.3.3.3.1: If/when resolvePromise is called with a value y, run [[Resolve]](promise, y).
               */
              return this.resolveProcedure(y, resolve, reject);
            },
            (r: any) => {
              if (runned) {
                return;
              }
              runned = true;
              /**
               * 2.3.3.3.2: If/when rejectPromise is called with a reason r, reject promise with r.
               */
              reject(r);
            }
          );
        } catch (e) {
          if (runned) {
            return;
          }
          runned = true;
          /**
           * 2.3.3.3.4: If calling then throws an exception e,
           * 2.3.3.3.4.1: If resolvePromise or rejectPromise have been called, ignore it.
           * 2.3.3.3.4.2: Otherwise, reject promise with e as the reason.
           */
          return reject(e);
        }
      } else {
        /**
         * 2.3.3.4 If then is not a function, fulfill promise with x.
         */
        return resolve(x);
      }
    } else {
      /**
       * 2.3.4: If x is not an object or function, fulfill promise with x.
       */
      return resolve(x);
    }
  }
}

try {
  if (module) {
    module.exports = PromisePolyfill;
  }
  // tslint:disable-next-line: no-empty
} catch {}
