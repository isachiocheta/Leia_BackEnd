-- Dashboard pessoal: totais de todas as leituras do usuário da sessão.
-- Bind: $usuario (id positivo, nunca selecionado pelo cliente).
-- Finalidade: manter o histórico mesmo sem ciclo EM_ANDAMENTO; conclusão usa
-- página final exata, sem depender de percentual arredondado ou situação do ciclo.
SELECT COUNT(p.id)::integer AS "totalParticipacoes",
  COUNT(p.id) FILTER (WHERE p.pagina_atual = l.total_paginas)::integer AS "leiturasConcluidas"
FROM participacoes_leitura p
JOIN ciclos_leitura c ON c.id = p.ciclo_id
JOIN livros l ON l.id = c.livro_id
WHERE p.usuario_id = $usuario;
