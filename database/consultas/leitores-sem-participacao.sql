-- Requisito 5: leitores ativos sem participação no ciclo, usando NOT EXISTS.
-- Bind: $ciclo (id positivo), $limite (1..50), $deslocamento (>=0).
-- Finalidade: identificar público elegível ainda sem adesão; não promove perfis.
SELECT u.id, u.nome
FROM usuarios u
WHERE u.perfil = 'LEITOR' AND u.situacao = 'ATIVO'
  AND NOT EXISTS (
    SELECT 1 FROM participacoes_leitura p
    WHERE p.usuario_id = u.id AND p.ciclo_id = $ciclo
  )
ORDER BY u.id ASC LIMIT $limite OFFSET $deslocamento;
