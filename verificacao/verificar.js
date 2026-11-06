'use strict';

const fs = require('node:fs/promises');
const caminho = require('node:path');
const os = require('node:os');
const { executarNode, executarNpm, backend } = require('./processos');

async function verificarInstalado() {
  const { validarBancoTeste } = require('../configuracao/banco');
  const { criarBancoTemporario } = require('../database/banco-temporario');
  const { instalarReferencia } = require('../database/exportar-sql');
  validarBancoTeste(process.env);
  await executarNpm(['ls', '--all'], process.env, { silencioso: true }); console.info('Dependências: árvore instalada válida.');
  const auditoria = await executarNpm(['audit', '--json'], process.env, { aceitarFalha: true, silencioso: true });
  const relatorio = JSON.parse(auditoria.stdout);
  if (!relatorio.metadata?.vulnerabilities) throw new Error('Auditoria de dependências indisponível; não há resultado a presumir.');
  const alertas = relatorio.metadata.vulnerabilities;
  console.info(`Auditoria npm: ${alertas.moderate} moderadas, ${alertas.high} altas, ${alertas.critical} críticas.`);
  if (alertas.high || alertas.critical) throw new Error('Auditoria contém alertas altos/críticos pendentes.');
  await executarNode('contracts/validar.js', [], process.env);
  const testes = await criarBancoTemporario('migracoes');
  try {
    await executarNode('database/executar-cli.js', ['db:migrate'], testes.variaveis, { silencioso: true });
    console.info('Testes principais e integrações em banco próprio migrado, sem dados preexistentes.');
    await executarNpm(['test'], testes.variaveis);
    await executarNpm(['run', 'test:integracao'], testes.variaveis);
  } finally { await testes.encerrar(); }
  const migracoes = await criarBancoTemporario('migracoes');
  try { console.info('Checagem completa de migrations up/down/up em outro banco vazio.'); await executarNpm(['run', 'test:migracoes'], migracoes.variaveis); }
  finally { await migracoes.encerrar(); }
  const cargas = await criarBancoTemporario('demonstracao');
  try {
    await executarNode('database/executar-cli.js', ['db:migrate'], cargas.variaveis, { silencioso: true });
    console.info('Cargas e reversões em banco próprio, migrado e ainda sem referência.');
    await executarNpm(['run', 'test:cargas'], cargas.variaveis);
  } finally { await cargas.encerrar(); }
  await require('./instalacao').verificarInstalacoes(process.env);
  console.info('Verificação concluída. Bancos preexistentes preservados; alertas npm acima permanecem explícitos.');
}

async function verificar() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Use Node.js 24 LTS.');
  // Esta guarda antecede cópia, instalação, qualquer conexão e qualquer teste.
  require('../configuracao/banco').validarBancoTeste(process.env);
  if (process.argv.includes('--instalado')) return verificarInstalado();
  const temporario = await fs.mkdtemp(caminho.join(os.tmpdir(), 'leia-verificacao-'));
  const destino = caminho.join(temporario, 'backend');
  try {
    await fs.cp(backend, destino, { recursive: true, filter: (arquivo) => !caminho.relative(backend, arquivo).split(caminho.sep).some((nome) =>
      ['node_modules', '.git', 'coverage', '.env', '.npmrc'].includes(nome) || /^README\.md$/i.test(nome) || (/^\.env\./.test(nome) && nome !== '.env.example') || /\.(?:pem|key|p12|pfx|log)$/.test(nome)) });
    console.info('Instalação limpa: arquivos fornecidos + npm ci em diretório temporário.');
    await executarNpm(['ci', '--no-audit', '--no-fund'], process.env, { cwd: destino });
    await executarNode('verificacao/verificar.js', ['--instalado'], process.env, { cwd: destino, prazoMs: 600000, linhas: Infinity });
  } finally { await fs.rm(temporario, { recursive: true, force: true }); }
}

if (require.main === module && !require('../utilitarios/ajuda').exibirAjuda('verificar')) verificar().catch((erro) => { console.error(erro.message); process.exitCode = 1; });
module.exports = { verificar, verificarInstalado };
