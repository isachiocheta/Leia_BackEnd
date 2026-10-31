'use strict';

function senhaValida(senha) {
  // Política compartilhada com o bootstrap. Espaços fazem parte da senha;
  // nunca usamos trim, normalização Unicode ou truncamento antes do bcrypt.
  return typeof senha === 'string' && Array.from(senha).length >= 10
    && Buffer.byteLength(senha, 'utf8') <= 72;
}

module.exports = { senhaValida };
