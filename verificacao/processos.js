'use strict';

const { spawn } = require('node:child_process');
const caminho = require('node:path');

const backend = caminho.resolve(__dirname, '..');

function sanitizar(texto, ambiente) {
  const segredos = Object.entries(ambiente).filter(([chave, valor]) => /SENHA|PASSWORD|SECRET/.test(chave) && typeof valor === 'string' && valor.length >= 4).map(([, valor]) => valor);
  for (const nome of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    if (!ambiente[nome]) continue;
    segredos.push(ambiente[nome]);
    try { const senha = decodeURIComponent(new URL(ambiente[nome]).password); if (senha) segredos.push(senha); } catch { /* Configuração validada pelo chamador. */ }
  }
  for (const segredo of segredos) texto = texto.split(segredo).join('[REMOVIDO]');
  return texto;
}

function executar(programa, argumentos, ambiente, { cwd = backend, aceitarFalha = false, silencioso = false, prazoMs = 180000, linhas = 14 } = {}) {
  return new Promise((resolver, rejeitar) => {
    const processo = spawn(programa, argumentos, { cwd, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let matar;
    const prazo = setTimeout(() => { processo.kill('SIGTERM'); matar = setTimeout(() => processo.kill('SIGKILL'), 5000); }, prazoMs);
    processo.stdout.setEncoding('utf8'); processo.stderr.setEncoding('utf8');
    processo.stdout.on('data', (dados) => { stdout += dados; }); processo.stderr.on('data', (dados) => { stderr += dados; });
    processo.on('error', () => { clearTimeout(prazo); clearTimeout(matar); rejeitar(new Error('Não foi possível iniciar uma ferramenta de verificação. Confira PATH e dependências.')); });
    processo.on('close', (codigo) => {
      clearTimeout(prazo); clearTimeout(matar);
      if (!silencioso || (codigo !== 0 && !aceitarFalha)) {
        const saida = sanitizar(`${stdout}\n${stderr}`, ambiente).trim().split('\n');
        console.info(saida.slice(Number.isFinite(linhas) ? -linhas : 0).join('\n'));
      }
      if (codigo !== 0 && !aceitarFalha) rejeitar(new Error(`Checagem não concluída (código ${codigo ?? 'sinal'}).`));
      else resolver({ codigo, stdout, stderr });
    });
  });
}

function executarNode(arquivo, argumentos, ambiente, opcoes) { return executar(process.execPath, [arquivo, ...argumentos], ambiente, opcoes); }
function executarNpm(argumentos, ambiente, opcoes) {
  return process.env.npm_execpath ? executar(process.execPath, [process.env.npm_execpath, ...argumentos], ambiente, opcoes) : executar(process.platform === 'win32' ? 'npm.cmd' : 'npm', argumentos, ambiente, opcoes);
}

module.exports = { executar, executarNode, executarNpm, sanitizar, backend };
