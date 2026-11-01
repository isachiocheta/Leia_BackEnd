'use strict';

const { dataCivilReal } = require('./datas-civis');

function instanteIsoComOffset(valor) {
  // Precisão de milissegundos do Date usado pelo model. Não aceita datas sem
  // offset, dias normalizados pelo parser ou frações que seriam truncadas.
  return typeof valor === 'string' &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(valor) &&
    dataCivilReal(valor.slice(0, 10)) && Number.isFinite(Date.parse(valor));
}

module.exports = { instanteIsoComOffset };
