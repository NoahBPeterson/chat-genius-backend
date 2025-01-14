open Pgx
open Lwt.Syntax
open Types

let pool = ref None

let init_pool ?(host="localhost") ?(port=5432) ?(user="postgres") ?(password="") ?(database="chat_genius") () =
  let* pool' = Pgx_lwt_unix.connect ~host ~port ~user ~password ~database () in
  pool := Some pool';
  Lwt.return_unit

let get_pool () =
  match !pool with
  | Some p -> p
  | None -> failwith "Database pool not initialized"

let get_user_by_id ~id =
  let query = "SELECT id, email, display_name, role, password_hash FROM users WHERE id = $1" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int id] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        email = to_string_exn (List.nth row 1);
        display_name = (match to_string (List.nth row 2) with Some s -> Some s | None -> None);
        role = to_string_exn (List.nth row 3);
        password_hash = to_string_exn (List.nth row 4);
        presence_status = "offline";  (* Default value *)
        last_active = "";  (* Will be set when they connect *)
      })
  | _ -> Lwt.return None

let get_user_by_email email =
  let query = "SELECT id, email, display_name, role, password_hash FROM users WHERE email = $1" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_string email] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        email = to_string_exn (List.nth row 1);
        display_name = (match to_string (List.nth row 2) with Some s -> Some s | None -> None);
        role = to_string_exn (List.nth row 3);
        password_hash = to_string_exn (List.nth row 4);
        presence_status = "offline";  (* Default value *)
        last_active = "";  (* Will be set when they connect *)
      })
  | _ -> Lwt.return None

let get_channel ~id =
  let query = "
    SELECT c.id, c.name, c.is_private, c.is_dm, 
           array_to_string(c.dm_participants, ',') AS participants,
           c.role 
    FROM channels c WHERE c.id = $1
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int id] in
  match rows with
  | [row] -> 
      let open Value in
      let dm_participants = 
        match to_string (List.nth row 4) with
        | None -> None
        | Some s when s = "" -> None
        | Some s -> Some (List.map int_of_string (String.split_on_char ',' s))
      in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        name = to_string_exn (List.nth row 1);
        is_private = to_bool_exn (List.nth row 2);
        is_dm = to_bool_exn (List.nth row 3);
        dm_participants;
        role = (match to_string (List.nth row 5) with Some s -> Some s | None -> None);
      })
  | _ -> Lwt.return None

let get_message ~id =
  let query = "SELECT id, content, user_id, channel_id, created_at, thread_id FROM messages WHERE id = $1" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int id] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        content = to_string_exn (List.nth row 1);
        user_id = to_int_exn (List.nth row 2);
        channel_id = to_int_exn (List.nth row 3);
        created_at = to_string_exn (List.nth row 4);
        thread_id = (match to_int (List.nth row 5) with Some i -> Some i | None -> None);
      })
  | _ -> Lwt.return None

let create_reaction ~message_id ~user_id ~emoji =
  let query = "INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) RETURNING id" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_int message_id;
    Value.of_int user_id;
    Value.of_string emoji;
  ] in
  match rows with
  | [row] -> Lwt.return (Some (Value.to_int_exn (List.hd row)))
  | _ -> Lwt.return None

let delete_reaction ~message_id ~user_id ~emoji =
  let query = "DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3" in
  let* _ = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_int message_id;
    Value.of_int user_id;
    Value.of_string emoji;
  ] in
  Lwt.return_unit

let create_message ~content ~user_id ~channel_id ~thread_id =
  let query = "
    INSERT INTO messages (content, user_id, channel_id, thread_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, content, user_id, channel_id, created_at, thread_id
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_string content;
    Value.of_int user_id;
    Value.of_int channel_id;
    (match thread_id with
     | Some id -> Value.of_int id
     | None -> Value.null);
  ] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        content = to_string_exn (List.nth row 1);
        user_id = to_int_exn (List.nth row 2);
        channel_id = to_int_exn (List.nth row 3);
        created_at = to_string_exn (List.nth row 4);
        thread_id = (match to_int (List.nth row 5) with Some i -> Some i | None -> None);
      })
  | _ -> Lwt.return None 

let create_user ~email ~password_hash ~display_name ~role =
  let query = "
    INSERT INTO users (email, password_hash, display_name, role)
    VALUES ($1, $2, $3, $4)
    RETURNING id, email, display_name, role, password_hash
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_string email;
    Value.of_string password_hash;
    (match display_name with Some n -> Value.of_string n | None -> Value.null);
    Value.of_string role;
  ] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        email = to_string_exn (List.nth row 1);
        display_name = (match to_string (List.nth row 2) with Some s -> Some s | None -> None);
        role = to_string_exn (List.nth row 3);
        password_hash = to_string_exn (List.nth row 4);
        presence_status = "offline";  (* Default value *)
        last_active = "";  (* Will be set when they connect *)
      })
  | _ -> Lwt.return None

let update_user ~id ?display_name ?password_hash () =
  let updates = List.filter_map (fun x -> x) [
    (match display_name with Some n -> Some ("display_name", Value.of_string n) | None -> None);
    (match password_hash with Some h -> Some ("password_hash", Value.of_string h) | None -> None);
  ] in
  if updates = [] then
    get_user_by_id ~id  (* No updates, just return current user *)
  else
    let set_clause = String.concat ", " (List.mapi (fun i (col, _) -> 
      Printf.sprintf "%s = $%d" col (i + 2)
    ) updates) in
    let query = Printf.sprintf "
      UPDATE users SET %s WHERE id = $1
      RETURNING id, email, display_name, role, password_hash
    " set_clause in
    let params = Value.of_int id :: List.map snd updates in
    let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params in
    match rows with
    | [row] -> 
        let open Value in
        Lwt.return (Some {
          id = to_int_exn (List.nth row 0);
          email = to_string_exn (List.nth row 1);
          display_name = (match to_string (List.nth row 2) with Some s -> Some s | None -> None);
          role = to_string_exn (List.nth row 3);
          password_hash = to_string_exn (List.nth row 4);
          presence_status = "offline";  (* Default value *)
          last_active = "";  (* Will be set when they connect *)
        })
    | _ -> Lwt.return None 

let get_all_channels () =
  let query = "SELECT * FROM channels" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[] in
  let channels = List.map (fun row ->
    let open Value in
    let dm_participants = 
      match to_string (List.nth row 4) with
      | None -> None
      | Some s when s = "" -> None
      | Some s -> Some (List.map int_of_string (String.split_on_char ',' s))
    in
    {
      id = to_int_exn (List.nth row 0);
      name = to_string_exn (List.nth row 1);
      is_private = to_bool_exn (List.nth row 2);
      is_dm = to_bool_exn (List.nth row 3);
      dm_participants;
      role = (match to_string (List.nth row 5) with Some s -> Some s | None -> None);
    }
  ) rows in
  Lwt.return channels

let create_channel ~name ~is_private =
  let query = "
    INSERT INTO channels (name, is_private)
    VALUES ($1, $2)
    RETURNING id, name, is_private, is_dm, dm_participants, role
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_string name;
    Value.of_bool is_private;
  ] in
  match rows with
  | [row] -> 
      let open Value in
      let dm_participants = 
        match to_string (List.nth row 4) with
        | None -> None
        | Some s when s = "" -> None
        | Some s -> Some (List.map int_of_string (String.split_on_char ',' s))
      in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        name = to_string_exn (List.nth row 1);
        is_private = to_bool_exn (List.nth row 2);
        is_dm = to_bool_exn (List.nth row 3);
        dm_participants;
        role = (match to_string (List.nth row 5) with Some s -> Some s | None -> None);
      })
  | _ -> Lwt.return None

let get_channel_messages ~channel_id =
  let query = "
    WITH message_reactions AS (
      SELECT 
        r.message_id,
        r.emoji,
        COUNT(*) as count,
        json_agg(r.user_id) as users
      FROM reactions r
      GROUP BY r.message_id, r.emoji
    ),
    message_attachments AS (
      SELECT 
        fa.message_id,
        json_agg(
          json_build_object(
            'id', fa.id,
            'filename', fa.filename,
            'mime_type', fa.mime_type,
            'size', fa.size,
            'storage_path', fa.storage_path,
            'is_image', fa.is_image
          )
        ) as attachments
      FROM file_attachments fa
      GROUP BY fa.message_id
    )
    SELECT 
      m.*,
      COALESCE(u.display_name, u.email) as display_name,
      COALESCE(ma.attachments, '[]'::json) as attachments,
      COALESCE(
        (
          SELECT json_object_agg(
            mr.emoji,
            json_build_object(
              'count', mr.count,
              'users', mr.users
            )
          )
          FROM message_reactions mr
          WHERE mr.message_id = m.id
        ),
        '{}'::json
      ) as reactions,
      EXISTS(
        SELECT 1 FROM threads t WHERE t.parent_message_id = m.id LIMIT 1
      ) as is_thread_parent,
      (
        SELECT json_build_object(
          'id', t.id,
          'reply_count', t.reply_count,
          'last_reply_at', t.last_reply_at
        )
        FROM threads t 
        WHERE t.parent_message_id = m.id
        LIMIT 1
      ) as thread
    FROM messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN message_attachments ma ON m.id = ma.message_id
    WHERE m.channel_id = $1 AND m.thread_id IS NULL
    ORDER BY m.created_at ASC
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int channel_id] in
  let messages = List.map (fun row ->
    let open Value in
    {
      id = to_int_exn (List.nth row 0);
      content = to_string_exn (List.nth row 1);
      user_id = to_int_exn (List.nth row 2);
      channel_id = to_int_exn (List.nth row 3);
      created_at = to_string_exn (List.nth row 4);
      thread_id = (match to_int (List.nth row 5) with Some i -> Some i | None -> None);
    }
  ) rows in
  Lwt.return messages 

let search_messages ~query:search_query ~user_id ~role =
  let query = "
    WITH accessible_channels AS (
      SELECT id FROM channels
      WHERE (
        (NOT is_dm AND (
          role IS NULL 
          OR role = $2 
          OR $3 = 'admin'
        ))
        OR
        (is_dm AND dm_participants @> ARRAY[$1]::integer[])
      )
    )
    SELECT 
      m.*,
      COALESCE(u.display_name, u.email) as display_name,
      c.name as channel_name,
      c.id as channel_id,
      c.is_dm,
      CASE 
        WHEN m.thread_id IS NOT NULL THEN t_parent.parent_message_id
        ELSE NULL
      END as thread_parent_message_id,
      CASE 
        WHEN m.thread_id IS NOT NULL THEN m.thread_id
        ELSE NULL
      END as thread_id
    FROM messages m
    JOIN users u ON m.user_id = u.id
    JOIN channels c ON m.channel_id = c.id
    LEFT JOIN threads t_parent ON m.thread_id = t_parent.id
    WHERE 
      m.channel_id IN (SELECT id FROM accessible_channels)
      AND m.content ILIKE $4
    ORDER BY m.created_at DESC
    LIMIT 50
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_int user_id;
    Value.of_string role;
    Value.of_string role;
    Value.of_string (Printf.sprintf "%%%s%%" search_query);
  ] in
  let messages = List.map (fun row ->
    let open Value in
    {
      id = to_int_exn (List.nth row 0);
      content = to_string_exn (List.nth row 1);
      user_id = to_int_exn (List.nth row 2);
      channel_id = to_int_exn (List.nth row 3);
      created_at = to_string_exn (List.nth row 4);
      thread_id = (match to_int (List.nth row 5) with Some i -> Some i | None -> None);
    }
  ) rows in
  Lwt.return messages

let get_thread ~id =
  let query = "SELECT * FROM threads WHERE id = $1" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int id] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        channel_id = to_int_exn (List.nth row 1);
        parent_message_id = to_int_exn (List.nth row 2);
        reply_count = to_int_exn (List.nth row 3);
        last_reply_at = to_string_exn (List.nth row 4);
      })
  | _ -> Lwt.return None

let get_thread_info ~thread_id =
  let query = "
    SELECT 
      t.*,
      m.content as thread_starter_content,
      COALESCE(u.display_name, u.email) as thread_starter_name,
      u.id as thread_starter_id
    FROM threads t
    JOIN messages m ON t.parent_message_id = m.id
    JOIN users u ON m.user_id = u.id
    WHERE t.id = $1
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int thread_id] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return {
        id = to_int_exn (List.nth row 0);
        channel_id = to_int_exn (List.nth row 1);
        reply_count = to_int_exn (List.nth row 3);
        last_reply_at = to_string_exn (List.nth row 4);
        thread_starter_content = to_string_exn (List.nth row 5);
        thread_starter_name = to_string_exn (List.nth row 6);
        thread_starter_id = to_int_exn (List.nth row 7);
      }
  | _ -> failwith "Thread not found"

let get_thread_messages ~thread_id =
  let query = "
    WITH message_reactions AS (
      SELECT 
        r.message_id,
        r.emoji,
        COUNT(*) as count,
        json_agg(r.user_id) as users
      FROM reactions r
      GROUP BY r.message_id, r.emoji
    ),
    message_attachments AS (
      SELECT 
        fa.message_id,
        json_agg(
          json_build_object(
            'id', fa.id,
            'filename', fa.filename,
            'mime_type', fa.mime_type,
            'size', fa.size,
            'storage_path', fa.storage_path,
            'is_image', fa.is_image
          )
        ) as attachments
      FROM file_attachments fa
      GROUP BY fa.message_id
    ),
    thread_messages AS (
      -- Get parent message
      SELECT * FROM messages WHERE id = (
        SELECT parent_message_id FROM threads WHERE id = $1
      )
      UNION ALL
      -- Get thread replies
      SELECT * FROM messages WHERE thread_id = $1
    )
    SELECT 
      m.*,
      COALESCE(u.display_name, u.email) as display_name,
      COALESCE(ma.attachments, '[]'::json) as attachments,
      COALESCE(
        (
          SELECT json_object_agg(
            mr.emoji,
            json_build_object(
              'count', mr.count,
              'users', mr.users
            )
          )
          FROM message_reactions mr
          WHERE mr.message_id = m.id
        ),
        '{}'::json
      ) as reactions
    FROM thread_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN message_attachments ma ON m.id = ma.message_id
    ORDER BY m.created_at ASC
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int thread_id] in
  let messages = List.map (fun row ->
    let open Value in
    {
      id = to_int_exn (List.nth row 0);
      content = to_string_exn (List.nth row 1);
      user_id = to_int_exn (List.nth row 2);
      channel_id = to_int_exn (List.nth row 3);
      created_at = to_string_exn (List.nth row 4);
      thread_id = (match to_int (List.nth row 5) with Some i -> Some i | None -> None);
    }
  ) rows in
  Lwt.return messages

let get_channel_threads ~channel_id =
  let query = "
    SELECT 
      t.*,
      m.content as thread_starter_content,
      COALESCE(u.display_name, u.email) as thread_starter_name,
      u.id as thread_starter_id
    FROM threads t
    JOIN messages m ON t.parent_message_id = m.id
    JOIN users u ON m.user_id = u.id
    WHERE t.channel_id = $1
    ORDER BY t.last_reply_at DESC
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_int channel_id] in
  let threads = List.map (fun row ->
    let open Value in
    {
      id = to_int_exn (List.nth row 0);
      channel_id = to_int_exn (List.nth row 1);
      reply_count = to_int_exn (List.nth row 3);
      last_reply_at = to_string_exn (List.nth row 4);
      thread_starter_content = to_string_exn (List.nth row 5);
      thread_starter_name = to_string_exn (List.nth row 6);
      thread_starter_id = to_int_exn (List.nth row 7);
    }
  ) rows in
  Lwt.return threads 

let get_file_by_storage_path ~storage_path =
  let query = "SELECT * FROM file_attachments WHERE storage_path LIKE $1" in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[Value.of_string (Printf.sprintf "%%%s" storage_path)] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        filename = to_string_exn (List.nth row 1);
        mime_type = to_string_exn (List.nth row 2);
        size = to_int_exn (List.nth row 3);
        storage_path = to_string_exn (List.nth row 4);
        is_image = to_bool_exn (List.nth row 5);
        message_id = (match to_int (List.nth row 6) with Some i -> Some i | None -> None);
      })
  | _ -> Lwt.return None

let create_file_attachment ~filename ~mime_type ~size ~storage_path ~is_image ~message_id =
  let query = "
    INSERT INTO file_attachments (filename, mime_type, size, storage_path, is_image, message_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, filename, mime_type, size, storage_path, is_image, message_id
  " in
  let* rows = Pgx_lwt_unix.execute (get_pool ()) query ~params:[
    Value.of_string filename;
    Value.of_string mime_type;
    Value.of_int size;
    Value.of_string storage_path;
    Value.of_bool is_image;
    (match message_id with Some id -> Value.of_int id | None -> Value.null);
  ] in
  match rows with
  | [row] -> 
      let open Value in
      Lwt.return (Some {
        id = to_int_exn (List.nth row 0);
        filename = to_string_exn (List.nth row 1);
        mime_type = to_string_exn (List.nth row 2);
        size = to_int_exn (List.nth row 3);
        storage_path = to_string_exn (List.nth row 4);
        is_image = to_bool_exn (List.nth row 5);
        message_id = (match to_int (List.nth row 6) with Some i -> Some i | None -> None);
      })
  | _ -> Lwt.return None 