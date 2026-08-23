// Crypto Reca v0.4.5 — never render missing ERS as a numeric-looking value
(function(){'use strict';const base=radarItem;radarItem=function(r){let h=base(r);if(r?.ers==null)h=h.replace(/ERS\s+—\/100/g,'ERS NO CALCULADO').replace(/ERS\s+0\/100/g,'ERS NO CALCULADO');return h};})();
