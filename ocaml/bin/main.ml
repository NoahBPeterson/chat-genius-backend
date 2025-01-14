open Chat_genius_lib
open Websocket_types
open Types
open Lwt.Syntax

let ws_manager = Websocket_manager.create ()

(* JWT verification *)
let verify_token token =
  try
    let secret = Sys.getenv "JWT_SECRET" in
    match Jwto.decode_and_verify secret token with
    | Ok jwt -> 
        let payload = Jwto.get_payload jwt in
        (match Jwto.get_claim "user_id" payload with
        | Some id -> 
            (try Ok (int_of_string id)
             with _ -> Error "Invalid user_id format")
        | None -> Error "Missing user_id claim")
    | Error _ -> Error "Invalid token"
  with
  | Not_found -> Error "JWT_SECRET not set"
  | _ -> Error "Token verification failed"

let handle_ws_client req ws =
  (* Get token from query parameters *)
  let token = Dream.query req "token" in
  match token with
  | None -> 
      let* () = Dream.close_websocket ~code:1008 ws in
      Dream.error (fun log -> log "WebSocket connection rejected: No authentication token");
      Lwt.return_unit
  | Some token ->
      match verify_token token with
      | Error msg ->
          let* () = Dream.close_websocket ~code:1008 ws in
          Dream.error (fun log -> log "WebSocket connection rejected: %s" msg);
          Lwt.return_unit
      | Ok user_id ->
          (* Look up user from database *)
          let* user_opt = Db.get_user_by_id ~id:user_id in
          match user_opt with
          | None ->
              let* () = Dream.close_websocket ~code:1008 ws in
              Dream.error (fun log -> log "WebSocket connection rejected: User not found");
              Lwt.return_unit
          | Some user ->
              let send msg =
                let json = server_message_to_yojson msg in
                let* () = Dream.send ws (Yojson.Safe.to_string json) in
                Lwt.return_unit
              in
              
              let* () = Websocket_manager.add_connection ws_manager user send in
              
              let rec message_loop () =
                let* message = Dream.receive ws in
                match message with
                | Some message ->
                    begin 
                      try
                        match Yojson.Safe.from_string message |> client_message_of_yojson with
                        | Ok client_msg ->
                            let* () = Websocket_manager.handle_client_message 
                              ws_manager { user; send } client_msg in
                            message_loop ()
                        | Error err ->
                            Dream.error (fun log -> log "Failed to parse message: %s" err);
                            message_loop ()
                      with e ->
                        Dream.error (fun log -> 
                          log "Error handling message: %s" (Printexc.to_string e));
                        message_loop ()
                    end
                | None ->
                    let* () = Websocket_manager.remove_connection ws_manager user.id in
                    Dream.info (fun log -> 
                      log "WebSocket connection closed for user %d" user.id);
                    Lwt.return_unit
              in
              
              Dream.info (fun log -> 
                log "WebSocket connection established for user %d" user.id);
              message_loop ()

let () =
  Dream.run 
    ~interface:"0.0.0.0" 
    ~port:8080
    @@ Dream.logger
    @@ Dream.router [
      (* User endpoints *)
      Dream.post "/api/auth/register" (fun request ->
        let* body = Dream.body request in
        match Yojson.Safe.from_string body |> registration_of_yojson with
        | Error _ -> Dream.json ~status:`Bad_Request {|{"error": "Invalid JSON"}|}
        | Ok { email; password; display_name } ->
            let* existing_user = Db.get_user_by_email email in
            match existing_user with
            | Some _ -> Dream.json ~status:`Conflict {|{"error": "Email already registered"}|}
            | None ->
                let password_hash = Cryptokit.hash_string (Cryptokit.Hash.sha256 ()) password in
                let* user_opt = Db.create_user ~email ~password_hash ~display_name ~role:"user" in
                match user_opt with
                | None -> Dream.json ~status:`Internal_Server_Error {|{"error": "Failed to create user"}|}
                | Some user ->
                    let token = Jwto.encode Jwto.HS256 
                      (Sys.getenv "JWT_SECRET")
                      [("user_id", string_of_int user.id)] in
                    match token with
                    | Ok token ->
                        Dream.json ~status:`Created (Printf.sprintf {|{"token": "%s", "user": %s}|}
                          token (user_to_yojson user |> Yojson.Safe.to_string))
                    | Error msg ->
                        Dream.json ~status:`Internal_Server_Error 
                          (Printf.sprintf {|{"error": "Failed to create token: %s"}|} msg)
      );

      Dream.post "/api/auth/login" (fun request ->
        let* body = Dream.body request in
        match Yojson.Safe.from_string body |> registration_of_yojson with
        | Error _ -> Dream.json ~status:`Bad_Request {|{"error": "Invalid JSON"}|}
        | Ok { email; password; _ } ->
            let* user_opt = Db.get_user_by_email email in
            match user_opt with
            | None -> Dream.json ~status:`Unauthorized {|{"error": "Invalid credentials"}|}
            | Some user ->
                let password_hash = Cryptokit.hash_string (Cryptokit.Hash.sha256 ()) password in
                if password_hash = user.password_hash then
                  let token = Jwto.encode Jwto.HS256 
                    (Sys.getenv "JWT_SECRET")
                    [("user_id", string_of_int user.id)] in
                  match token with
                  | Ok token ->
                      Dream.json (Printf.sprintf {|{"token": "%s", "user": %s}|}
                        token (user_to_yojson user |> Yojson.Safe.to_string))
                  | Error msg ->
                      Dream.json ~status:`Internal_Server_Error 
                        (Printf.sprintf {|{"error": "Failed to create token: %s"}|} msg)
                else
                  Dream.json ~status:`Unauthorized {|{"error": "Invalid credentials"}|}
      );

      Dream.get "/api/users/me" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some auth ->
            match String.split_on_char ' ' auth with
            | ["Bearer"; token] ->
                (match verify_token token with
                | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
                | Ok user_id ->
                    let* user_opt = Db.get_user_by_id ~id:user_id in
                    match user_opt with
                    | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                    | Some user -> 
                        Dream.json (user_to_yojson user |> Yojson.Safe.to_string))
            | _ -> Dream.json ~status:`Unauthorized {|{"error": "Invalid authorization header"}|}
      );

      Dream.put "/api/users/me" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some auth ->
            match String.split_on_char ' ' auth with
            | ["Bearer"; token] ->
                (match verify_token token with
                | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
                | Ok user_id ->
                    let* body = Dream.body request in
                    match Yojson.Safe.from_string body with
                    | exception _ -> Dream.json ~status:`Bad_Request {|{"error": "Invalid JSON"}|}
                    | json ->
                        let updates = Yojson.Safe.Util.(
                          let display_name = member "display_name" json |> to_string_option in
                          let password = member "password" json |> to_string_option in
                          (display_name, password)
                        ) in
                        match updates with
                        | exception _ -> Dream.json ~status:`Bad_Request {|{"error": "Invalid fields"}|}
                        | (display_name, password) ->
                            let password_hash = match password with
                              | Some p -> Some (Cryptokit.hash_string (Cryptokit.Hash.sha256 ()) p)
                              | None -> None
                            in
                            let* user_opt = Db.update_user ~id:user_id ?display_name ?password_hash () in
                            match user_opt with
                            | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                            | Some user -> 
                                Dream.json (user_to_yojson user |> Yojson.Safe.to_string))
            | _ -> Dream.json ~status:`Unauthorized {|{"error": "Invalid authorization header"}|}
      );

      (* WebSocket endpoint *)
      Dream.get "/ws" (fun req ->
        Dream.websocket (handle_ws_client req)
      );
    ] 