const _ = require('lodash/core');
import { Directive, ElementRef, Input, HostBinding, OnInit } from '@angular/core';
import { Auth } from '../services/auth.service';

@Directive({
  selector: '[mmAuth]'
})
export class AuthDirective implements OnInit {
  @Input() mmAuth: string;
  @Input() mmAuthAny: any;
  @Input() mmAuthOnline: boolean;

  protected hidden = true;

  constructor(
    private el: ElementRef,
    private auth: Auth,
  ) { }

  ngOnInit() {
    console.log(this.mmAuth, this.mmAuthAny, this.mmAuthOnline);
    const dynamicChecks = allowed => {
      if (allowed && this.mmAuthAny) {
        const mmAuthAny = Array.isArray(this.mmAuthAny) ? this.mmAuthAny : [this.mmAuthAny];
        if (mmAuthAny.some(property => property === true)) {
          this.hidden = false;
          return;
        }

        const permissionsGroups = mmAuthAny
          .filter(property => Array.isArray(property) || _.isString(property))
          .map(property => (Array.isArray(property) && _.flattenDeep(property)) || [ property ]);

        if (!permissionsGroups.length) {
          this.hidden = true;
          return;
        }

        return updateVisibility([ this.auth.any(permissionsGroups) ]);
      }
    };


    const updateVisibility = promises => {
      return Promise
        .all(promises)
        .then(permissions => {
          const allPermissions = permissions.every(permission => !!permission);
          if (allPermissions) {
            this.hidden = false;
            return true;
          }

          console.debug('mmAuth failed authorization check');
          this.hidden = true;
          return false;
        });
    };

    const staticChecks = () => {
      const promises = [];
      if (this.mmAuth) {
        promises.push(this.auth.has(this.mmAuth.split(',')));
      }

      if (this.mmAuthOnline) {
        const onlineResult = this.auth.online(this.mmAuthOnline);
        promises.push(Promise.resolve(onlineResult));
      }

      if (!promises.length) {
        return true;
      }

      return updateVisibility(promises);
    };

    const result = staticChecks();
    if (result === true) {
      dynamicChecks(true);
    } else {
      result.then(dynamicChecks);
    }
  }

  @HostBinding('class.hidden')
  public get isHidden(): boolean {
    return this.hidden;
  }
}
/*
angular.module('inboxDirectives').directive('mmAuth', function(
  $log,
  $parse,
  $q,
  Auth
) {
  'use strict';
  'ngInject';

  const link = function(scope, element, attributes) {

    element.addClass('hidden');

  };

  return {
    restrict: 'A',
    link,
  };
});
*/
