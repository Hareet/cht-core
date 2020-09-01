import {Injectable} from '@angular/core';
import {Changes} from "./changes.service";

@Injectable({
  providedIn: 'root'
})
export class Cache {
  private caches = [];

  constructor(private changes:Changes) {
    this.changes.register({
      key: 'cache',
      callback: function(change) {
        this.caches.forEach((cache) => {
          if (cache.invalidate(change)) {
            cache.docs = null;
            cache.pending = false;
          }
        });
      }
    })
  }

  /**
    * Caches results and invalidates on document change to reduce
    * the number of requests made to the database.
  *
  * @param options (Object)
  *   - get (function): The function to call to populate the cache.
  *   - invalidate (function) (optional): A predicate which will be
    *     invoked when a database change is detected. Given the
    *     modified doc return true if the cache should be invalidated.
    *     If no invalidate function is provided the cache will never
    *     invalidate.
  */
  register(options) {
    const cache = {
      docs: null,
      pending: false,
      invalidate: options.invalidate,
      callbacks: []
    };

    this.caches.push(cache);

    return (callback) => {
      if (cache.docs) {
        return callback(null, cache.docs);
      }
      cache.callbacks.push(callback);
      if (cache.pending) {
        return;
      }
      cache.pending = true;
      options.get((err, result) => {
        cache.pending = false;
        if (!err) {
          cache.docs = result;
        }
        cache.callbacks.forEach((callback) => {
          callback(err, result);
        });
        cache.callbacks = [];
      });
    };
  }

}

/*(function () {

  'use strict';

  angular.module('inboxServices').factory('Cache',
    function(Changes) {
      'ngInject';

      const caches = [];

      Changes({

      });

      /!**
       * Caches results and invalidates on document change to reduce
       * the number of requests made to the database.
       *
       * @param options (Object)
       *   - get (function): The function to call to populate the cache.
       *   - invalidate (function) (optional): A predicate which will be
       *     invoked when a database change is detected. Given the
       *     modified doc return true if the cache should be invalidated.
       *     If no invalidate function is provided the cache will never
       *     invalidate.
       *!/
      return function(options) {


      };
    }
  );

}()); */
