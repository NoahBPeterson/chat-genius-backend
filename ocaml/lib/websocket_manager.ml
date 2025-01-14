open Websocket_types
open Types
open Lwt.Syntax

module ConnectionMap = Map.Make(Int)

type t = {
  mutable connections: connection ConnectionMap.t;
}

let create () = {
  connections = ConnectionMap.empty;
}

let add_connection t user send =
  let conn = { user; send } in
  t.connections <- ConnectionMap.add user.id conn t.connections;
  Lwt.return_unit

let remove_connection t user_id =
  t.connections <- ConnectionMap.remove user_id t.connections;
  Lwt.return_unit

let broadcast_to_channel t channel_id msg =
  let* channel_opt = Db.get_channel ~id:channel_id in
  match channel_opt with
  | None -> Lwt.return_unit  (* Channel doesn't exist *)
  | Some channel ->
      let send_to_conn (_user_id, conn) =
        (* For DM channels, only send to participants *)
        if channel.is_dm then
          match channel.dm_participants with
          | Some participants -> 
              if List.mem conn.user.id participants then
                conn.send msg
              else
                Lwt.return_unit
          | None -> Lwt.return_unit
        (* For private channels, check role *)
        else if channel.is_private then
          match channel.role with
          | Some required_role when conn.user.role = required_role ->
              conn.send msg
          | _ -> Lwt.return_unit
        (* For public channels, send to everyone *)
        else
          conn.send msg
      in
      Lwt_list.iter_p send_to_conn (ConnectionMap.bindings t.connections)

let handle_client_message t (conn : connection) (msg : client_message) =
  match msg with
  | NewMessage { content; channel_id; thread_id } ->
      let* message_opt = Db.create_message ~content ~user_id:conn.user.id ~channel_id ~thread_id in
      (match message_opt with
      | Some message ->
          let* () = broadcast_to_channel t channel_id (MessageCreated message) in
          Lwt.return_unit
      | None ->
          Dream.error (fun log -> 
            log "Failed to create message for user %d in channel %d" 
              conn.user.id channel_id);
          Lwt.return_unit)
  
  | CreateThread { parent_message_id; content } ->
      let* parent_opt = Db.get_message ~id:parent_message_id in
      (match parent_opt with
      | None -> 
          Dream.error (fun log -> 
            log "Parent message %d not found for thread creation" parent_message_id);
          Lwt.return_unit
      | Some parent ->
          let* message_opt = Db.create_message ~content ~user_id:conn.user.id 
            ~channel_id:parent.channel_id ~thread_id:(Some parent_message_id) in
          (match message_opt with
          | Some message ->
              let* () = broadcast_to_channel t message.channel_id (ThreadCreated message) in
              Lwt.return_unit
          | None ->
              Dream.error (fun log -> 
                log "Failed to create thread message for user %d in channel %d" 
                  conn.user.id parent.channel_id);
              Lwt.return_unit))
  
  | TypingStart { channel_id } ->
      let* () = broadcast_to_channel t channel_id
        (UserTyping { user = conn.user; channel_id }) in
      Lwt.return_unit
  
  | TypingStop { channel_id } ->
      let* () = broadcast_to_channel t channel_id
        (UserStoppedTyping { user = conn.user; channel_id }) in
      Lwt.return_unit
  
  | AddReaction { message_id; emoji } ->
      let* message_opt = Db.get_message ~id:message_id in
      (match message_opt with
      | None ->
          Dream.error (fun log -> 
            log "Message %d not found for reaction" message_id);
          Lwt.return_unit
      | Some message ->
          let* reaction_opt = Db.create_reaction ~message_id ~user_id:conn.user.id ~emoji in
          match reaction_opt with
          | Some _ ->
              let* () = broadcast_to_channel t message.channel_id
                (ReactionAdded { message_id; emoji; user_id = conn.user.id }) in
              Lwt.return_unit
          | None ->
              Dream.error (fun log -> 
                log "Failed to create reaction for user %d on message %d" 
                  conn.user.id message_id);
              Lwt.return_unit)
  
  | RemoveReaction { message_id; emoji } ->
      let* message_opt = Db.get_message ~id:message_id in
      (match message_opt with
      | None ->
          Dream.error (fun log -> 
            log "Message %d not found for reaction removal" message_id);
          Lwt.return_unit
      | Some message ->
          let* () = Db.delete_reaction ~message_id ~user_id:conn.user.id ~emoji in
          let* () = broadcast_to_channel t message.channel_id
            (ReactionRemoved { message_id; emoji; user_id = conn.user.id }) in
          Lwt.return_unit) 