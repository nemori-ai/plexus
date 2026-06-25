/* esm.sh - react@18.3.1/jsx-runtime */
import*as __0$ from"react";var require=n=>{const e=m=>typeof m.default<"u"?m.default:m,c=m=>Object.assign({__esModule:true},m);switch(n){case"react":return e(__0$);default:console.error('module "'+n+'" not found');return null;}};
var y=Object.create;var l=Object.defineProperty;var j=Object.getOwnPropertyDescriptor;var x=Object.getOwnPropertyNames;var O=Object.getPrototypeOf,a=Object.prototype.hasOwnProperty;var v=(r=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(r,{get:(e,o)=>(typeof require<"u"?require:e)[o]}):r)(function(r){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+r+'" is not supported')});var i=(r,e)=>()=>(e||r((e={exports:{}}).exports,e),e.exports);var E=(r,e,o,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let s of x(e))!a.call(r,s)&&s!==o&&l(r,s,{get:()=>e[s],enumerable:!(t=j(e,s))||t.enumerable});return r};var k=(r,e,o)=>(o=r!=null?y(O(r)):{},E(e||!r||!r.__esModule?l(o,"default",{value:r,enumerable:!0}):o,r));var c=i(n=>{"use strict";var N=v("react"),R=Symbol.for("react.element"),S=Symbol.for("react.fragment"),b=Object.prototype.hasOwnProperty,q=N.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner,w={key:!0,ref:!0,__self:!0,__source:!0};function _(r,e,o){var t,s={},p=null,u=null;o!==void 0&&(p=""+o),e.key!==void 0&&(p=""+e.key),e.ref!==void 0&&(u=e.ref);for(t in e)b.call(e,t)&&!w.hasOwnProperty(t)&&(s[t]=e[t]);if(r&&r.defaultProps)for(t in e=r.defaultProps,e)s[t]===void 0&&(s[t]=e[t]);return{$$typeof:R,type:r,key:p,ref:u,props:s,_owner:q.current}}n.Fragment=S;n.jsx=_;n.jsxs=_});var d=i((D,m)=>{"use strict";m.exports=c()});var f=k(d()),{Fragment:F,jsx:I,jsxs:L}=f,T=f.default??f;export{F as Fragment,T as default,I as jsx,L as jsxs};
/*! Bundled license information:

react/cjs/react-jsx-runtime.production.min.js:
  (**
   * @license React
   * react-jsx-runtime.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
