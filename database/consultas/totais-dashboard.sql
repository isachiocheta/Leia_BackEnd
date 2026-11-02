-- Dashboard administrativo: contagens independentes, sem multiplicação por JOINs.
-- Bind: $agora (único instante também usado em generatedAt e no período do ciclo).
-- Finalidade: leitores do perfil LEITOR; encontros apenas AGENDADOS com início > agora.
SELECT
  (SELECT COUNT(*)::integer FROM usuarios WHERE perfil = 'LEITOR' AND situacao = 'ATIVO') AS "leitoresAtivos",
  (SELECT COUNT(*)::integer FROM usuarios WHERE perfil = 'LEITOR' AND situacao = 'PENDENTE') AS "leitoresPendentes",
  (SELECT COUNT(*)::integer FROM livros) AS "totalLivros",
  (SELECT COUNT(*)::integer FROM ciclos_leitura) AS "totalCiclos",
  (SELECT COUNT(*)::integer FROM encontros WHERE situacao = 'AGENDADO' AND inicio_em > $agora::timestamptz) AS "encontrosAgendadosFuturos";
