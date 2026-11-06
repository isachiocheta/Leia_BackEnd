'use strict';

const { readFile } = require('node:fs/promises');
const caminho = require('node:path');
const YAML = require('yaml');
const Parser = require('@apidevtools/swagger-parser');
const Ajv = require('ajv');
const { Validator } = require('sequelize');
const { inventariarRotas } = require('./rotas');
const { dataCivilReal } = require('../utilitarios/datas-civis');

function conferirRotas(contrato) {
  const descritas = Object.entries(contrato.paths).flatMap(([rota, item]) => Object.keys(item).filter((metodo) => ['get','post','patch','delete','put','head','options'].includes(metodo)).map((metodo) => `${metodo.toUpperCase()} ${rota}`)).sort();
  if (JSON.stringify(descritas) !== JSON.stringify(inventariarRotas())) throw new Error('Operações OpenAPI divergem das rotas reais.');
  for (const item of Object.values(contrato.paths)) for (const operacao of Object.values(item)) {
    if (!Array.isArray(operacao['x-perfis']) || operacao['x-perfis'].some((perfil) => !['ADMIN_CLUBE','LEITOR'].includes(perfil))) throw new Error('Perfis contratuais inválidos.');
    if (operacao.responses['204']?.content) throw new Error('Resposta 204 não pode declarar corpo.');
  }
  return descritas.length;
}

async function lerContrato() {
  const documento = YAML.parseDocument(await readFile(caminho.join(__dirname, 'openapi.yaml'), 'utf8'), { uniqueKeys: true });
  if (documento.errors.length) throw new Error('YAML do contrato inválido.');
  const contrato = documento.toJS({ maxAliasCount: 50 });
  function referencias(valor) {
    if (!valor || typeof valor !== 'object') return;
    if (valor.$ref && !valor.$ref.startsWith('#/')) throw new Error('Contrato não pode depender de referências externas.');
    Object.values(valor).forEach(referencias);
  }
  referencias(contrato);
  await Parser.validate(structuredClone(contrato), { resolve: { external: false } });
  conferirRotas(contrato);
  return contrato;
}

function criarValidadorTrocas(contrato) {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  ajv.addFormat('date', dataCivilReal);
  ajv.addFormat('date-time', (valor) => /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(valor) && Number.isFinite(Date.parse(valor)));
  ajv.addFormat('email', (valor) => Validator.isEmail(valor));
  ajv.addFormat('uri', (valor) => { try { return Boolean(new URL(valor).protocol); } catch { return false; } });
  ajv.addKeyword({ keyword: 'x-maxUtf8Bytes', type: 'string', schemaType: 'number', validate: (maximo, valor) => Buffer.byteLength(valor, 'utf8') <= maximo });
  ajv.addSchema({ $id: 'leia', components: contrato.components }, 'leia');
  const cache = new Map(); const cobertas = new Set();
  const resolver = (valor) => valor?.$ref ? valor.$ref.slice(2).split('/').reduce((atual, parte) => atual[parte], contrato) : valor;
  function validar(schema, valor, contexto) {
    const chave = JSON.stringify(schema);
    if (!cache.has(chave)) cache.set(chave, ajv.compile({ ...schema, ...(schema.$ref ? { $ref: `leia${schema.$ref}` } : {}), components: contrato.components }));
    const teste = cache.get(chave);
    if (!teste(valor)) throw new Error(`Contrato divergente (${contexto}): ${ajv.errorsText(teste.errors)}`);
  }
  function conferir(metodo, url, resposta, corpo) {
    const endereco = new URL(url, 'http://localhost'); const verbo = metodo.toLowerCase();
    const rota = Object.keys(contrato.paths).find((path) => new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(endereco.pathname));
    const operacao = contrato.paths[rota]?.[verbo];
    if (!operacao) throw new Error(`Operação fora do contrato: ${metodo} ${endereco.pathname}`);
    const declarada = resolver(operacao.responses[String(resposta.status)]);
    if (!declarada) throw new Error(`Status não documentado: ${metodo} ${rota} ${resposta.status}`);
    if (resposta.status === 204) {
      if (resposta.text || resposta.headers['content-type']) throw new Error('204 com corpo/tipo de conteúdo.');
    } else {
      if (!/application\/json/.test(resposta.headers['content-type'] || '')) throw new Error('Resposta não JSON.');
      validar(declarada.content['application/json'].schema, resposta.body, `resposta ${metodo} ${rota}`);
    }
    if (resposta.status < 400) {
      if (operacao.requestBody?.required && corpo === undefined) throw new Error('Corpo contratual obrigatório ausente.');
      if (operacao.requestBody && corpo !== undefined) validar(operacao.requestBody.content['application/json'].schema, corpo, `corpo ${metodo} ${rota}`);
      for (const parametro of (operacao.parameters || []).map(resolver).filter((item) => item.in === 'query')) {
        if (!endereco.searchParams.has(parametro.name)) continue;
        const esquema = resolver(parametro.schema); let valor = endereco.searchParams.get(parametro.name);
        if (esquema.type === 'integer') valor = Number(valor);
        if (esquema.type === 'boolean') valor = valor === 'true' ? true : valor === 'false' ? false : valor;
        validar(esquema, valor, `parâmetro ${parametro.name}`);
      }
      cobertas.add(`${verbo.toUpperCase()} ${rota}`);
    }
    return resposta;
  }
  return { conferir, cobertas };
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.info('npm run verificar:contrato — valida YAML/OpenAPI 3.0.3, referências locais e igualdade com operações montadas no app.js. Não conecta ao banco nem abre porta.');
  else lerContrato().then((contrato) => console.info(`OpenAPI válido: ${conferirRotas(contrato)} operações correspondem às rotas reais.`)).catch((erro) => { console.error(erro.message); process.exitCode = 1; });
}
module.exports = { lerContrato, conferirRotas, criarValidadorTrocas };
