-- Requisito 2: participantes, conclusões, taxa de conclusão e média de progresso.
-- Bind: $ciclo (id positivo). Taxa e média são percentuais de 0 a 100.
-- Finalidade: resumo administrativo, incluindo ciclo sem participantes com zeros.
-- Conclusão usa a página exata; encontros/inscrições não multiplicam agregações.
SELECT c.id AS "cicloId", c.nome, l.id AS "livroId",
  COUNT(p.id)::integer AS participantes,
  COUNT(p.id) FILTER (WHERE p.pagina_atual = l.total_paginas)::integer AS conclusoes,
  COALESCE(ROUND(100.0 * COUNT(p.id) FILTER (WHERE p.pagina_atual = l.total_paginas)
    / NULLIF(COUNT(p.id), 0), 2), 0)::double precision AS "taxaConclusao",
  COALESCE(ROUND(AVG(p.pagina_atual::numeric * 100 / l.total_paginas), 2), 0)::double precision AS "mediaProgresso"
FROM ciclos_leitura c
JOIN livros l ON l.id = c.livro_id
LEFT JOIN participacoes_leitura p ON p.ciclo_id = c.id
WHERE c.id = $ciclo
GROUP BY c.id, c.nome, l.id, l.total_paginas;
