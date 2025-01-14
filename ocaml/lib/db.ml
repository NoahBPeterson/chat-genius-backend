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