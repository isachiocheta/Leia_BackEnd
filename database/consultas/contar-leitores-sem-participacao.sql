-- Apoio ao requisito 5 e ao dashboard: total da seleção NOT EXISTS, sem limite.
-- Bind: $ciclo (id positivo). Finalidade: distinguir total e lista limitada.
SELECT COUNT(*)::integer AS total FROM usuarios u
WHERE u.perfil = 'LEITOR' AND u.situacao = 'ATIVO'
  AND NOT EXISTS (
    SELECT 1 FROM participacoes_leitura p
    WHERE p.usuario_id = u.id AND p.ciclo_id = $ciclo
  );
