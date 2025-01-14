open Chat_genius_lib
open Websocket_types
open Types
open Lwt.Syntax

module S3_client = struct
  module S3 = Aws_s3.S3.Make(Aws_s3_lwt.Io)
  module Credentials = Aws_s3.Credentials
  module Region = Aws_s3.Region

  let make_credentials ~access_key ~secret_key =
    Credentials.make ~access_key ~secret_key ()

  let presign_put ~credentials ~region ~bucket ~key ~content_type () =
    let endpoint = Region.endpoint ~inet:`V4 ~scheme:`Https region in
    let* result = S3.put ~content_type ~credentials ~endpoint ~bucket ~key ~data:"" () in
    Lwt.return (
      match result with
      | Ok _etag -> Ok (Printf.sprintf "https://%s.s3.%s.amazonaws.com/%s" bucket (Region.to_string region) key)
      | Error e -> Error e
    )

  let presign_get ~credentials ~region ~bucket ~key () =
    let endpoint = Region.endpoint ~inet:`V4 ~scheme:`Https region in
    let* result = S3.get ~credentials ~endpoint ~bucket ~key () in
    Lwt.return (
      match result with
      | Ok _data -> Ok (Printf.sprintf "https://%s.s3.%s.amazonaws.com/%s" bucket (Region.to_string region) key)
      | Error e -> Error e
    )
end

let ws_manager = Websocket_manager.create ()
let s3_client = ref None

let init_s3_client () =
  let region = Sys.getenv "AWS_REGION" in
  let access_key = Sys.getenv "AWS_ACCESS_KEY_ID" in
  let secret_key = Sys.getenv "AWS_SECRET_ACCESS_KEY" in
  let bucket = Sys.getenv "AWS_BUCKET_NAME" in
  let credentials = S3_client.make_credentials ~access_key ~secret_key in
  let region = S3_client.Region.of_string region in
  s3_client := Some (credentials, region, bucket)

let get_s3_client () =
  match !s3_client with
  | Some c -> c
  | None -> failwith "S3 client not initialized"

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
  init_s3_client ();
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

      (* Channel endpoints *)
      Dream.get "/api/channels" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some _user ->
                    let* channels = Db.get_all_channels () in
                    Dream.json (channels_to_yojson channels |> Yojson.Safe.to_string)
      );

      Dream.post "/api/channels" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some _user ->
                    let* body = Dream.body request in
                    match Yojson.Safe.from_string body with
                    | exception _ -> Dream.json ~status:`Bad_Request {|{"error": "Invalid JSON"}|}
                    | json ->
                        let open Yojson.Safe.Util in
                        try
                          let name = member "name" json |> to_string in
                          let is_private = member "isPrivate" json |> to_bool in
                          let* channel_opt = Db.create_channel ~name ~is_private in
                          match channel_opt with
                          | None -> Dream.json ~status:`Internal_Server_Error {|{"error": "Failed to create channel"}|}
                          | Some channel ->
                              Dream.json ~status:`Created (channel_to_yojson channel |> Yojson.Safe.to_string)
                        with Type_error _ ->
                          Dream.json ~status:`Bad_Request {|{"error": "Missing or invalid fields"}|}
      );

      Dream.get "/api/channels/:id" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some _user ->
                    match Dream.param request "id" |> int_of_string_opt with
                    | None -> Dream.json ~status:`Bad_Request {|{"error": "Invalid channel ID"}|}
                    | Some channel_id ->
                        let* channel_opt = Db.get_channel ~id:channel_id in
                        match channel_opt with
                        | None -> Dream.json ~status:`Not_Found {|{"error": "Channel not found"}|}
                        | Some channel ->
                            Dream.json (channel_to_yojson channel |> Yojson.Safe.to_string)
      );

      Dream.get "/api/channels/:id/messages" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some user ->
                    match Dream.param request "id" |> int_of_string_opt with
                    | None -> Dream.json ~status:`Bad_Request {|{"error": "Invalid channel ID"}|}
                    | Some channel_id ->
                        let* channel_opt = Db.get_channel ~id:channel_id in
                        match channel_opt with
                        | None -> Dream.json ~status:`Not_Found {|{"error": "Channel not found"}|}
                        | Some channel ->
                            (* Check access permissions *)
                            if channel.is_dm then
                              match channel.dm_participants with
                              | Some participants when List.mem user.id participants ->
                                  let* messages = Db.get_channel_messages ~channel_id in
                                  Dream.json (messages_to_yojson messages |> Yojson.Safe.to_string)
                              | _ ->
                                  Dream.json ~status:`Forbidden 
                                    {|{"error": "Forbidden: You are not a participant in this conversation"}|}
                            else if channel.is_private then
                              match channel.role with
                              | Some required_role when user.role = required_role || user.role = "admin" ->
                                  let* messages = Db.get_channel_messages ~channel_id in
                                  Dream.json (messages_to_yojson messages |> Yojson.Safe.to_string)
                              | _ ->
                                  Dream.json ~status:`Forbidden 
                                    {|{"error": "Forbidden: You do not have access to this channel"}|}
                            else
                              let* messages = Db.get_channel_messages ~channel_id in
                              Dream.json (messages_to_yojson messages |> Yojson.Safe.to_string)
      );

      (* Message endpoints *)
      Dream.get "/api/messages/search" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some user ->
                    match Dream.query request "query" with
                    | None -> Dream.json ~status:`Bad_Request {|{"error": "Search query is required"}|}
                    | Some query ->
                        let* messages = Db.search_messages ~query ~user_id:user.id ~role:user.role in
                        Dream.json (messages_to_yojson messages |> Yojson.Safe.to_string)
      );

      Dream.get "/api/threads/:threadId/messages" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some user ->
                    match Dream.param request "threadId" |> int_of_string_opt with
                    | None -> Dream.json ~status:`Bad_Request {|{"error": "Invalid thread ID"}|}
                    | Some thread_id ->
                        let* thread_opt = Db.get_thread ~id:thread_id in
                        match thread_opt with
                        | None -> Dream.json ~status:`Not_Found {|{"error": "Thread not found"}|}
                        | Some thread ->
                            let* channel_opt = Db.get_channel ~id:thread.channel_id in
                            match channel_opt with
                            | None -> Dream.json ~status:`Not_Found {|{"error": "Channel not found"}|}
                            | Some channel ->
                                (* Check access permissions *)
                                if channel.is_dm then
                                  match channel.dm_participants with
                                  | Some participants when List.mem user.id participants ->
                                      let* thread_info = Db.get_thread_info ~thread_id in
                                      let* messages = Db.get_thread_messages ~thread_id in
                                      Dream.json (Printf.sprintf {|{"thread": %s, "messages": %s}|}
                                        (thread_info_to_yojson thread_info |> Yojson.Safe.to_string)
                                        (messages_to_yojson messages |> Yojson.Safe.to_string))
                                  | _ ->
                                      Dream.json ~status:`Forbidden 
                                        {|{"error": "Forbidden: You are not a participant in this conversation"}|}
                                else if channel.is_private then
                                  match channel.role with
                                  | Some required_role when user.role = required_role || user.role = "admin" ->
                                      let* thread_info = Db.get_thread_info ~thread_id in
                                      let* messages = Db.get_thread_messages ~thread_id in
                                      Dream.json (Printf.sprintf {|{"thread": %s, "messages": %s}|}
                                        (thread_info_to_yojson thread_info |> Yojson.Safe.to_string)
                                        (messages_to_yojson messages |> Yojson.Safe.to_string))
                                  | _ ->
                                      Dream.json ~status:`Forbidden 
                                        {|{"error": "Forbidden: You do not have access to this channel"}|}
                                else
                                  let* thread_info = Db.get_thread_info ~thread_id in
                                  let* messages = Db.get_thread_messages ~thread_id in
                                  Dream.json (Printf.sprintf {|{"thread": %s, "messages": %s}|}
                                    (thread_info_to_yojson thread_info |> Yojson.Safe.to_string)
                                    (messages_to_yojson messages |> Yojson.Safe.to_string))
      );

      Dream.get "/api/channels/:channelId/threads" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some user ->
                    match Dream.param request "channelId" |> int_of_string_opt with
                    | None -> Dream.json ~status:`Bad_Request {|{"error": "Invalid channel ID"}|}
                    | Some channel_id ->
                        let* channel_opt = Db.get_channel ~id:channel_id in
                        match channel_opt with
                        | None -> Dream.json ~status:`Not_Found {|{"error": "Channel not found"}|}
                        | Some channel ->
                            (* Check access permissions *)
                            if channel.is_dm then
                              match channel.dm_participants with
                              | Some participants when List.mem user.id participants ->
                                  let* threads = Db.get_channel_threads ~channel_id in
                                  Dream.json (threads_to_yojson threads |> Yojson.Safe.to_string)
                              | _ ->
                                  Dream.json ~status:`Forbidden 
                                    {|{"error": "Forbidden: You are not a participant in this conversation"}|}
                            else if channel.is_private then
                              match channel.role with
                              | Some required_role when user.role = required_role || user.role = "admin" ->
                                  let* threads = Db.get_channel_threads ~channel_id in
                                  Dream.json (threads_to_yojson threads |> Yojson.Safe.to_string)
                              | _ ->
                                  Dream.json ~status:`Forbidden 
                                    {|{"error": "Forbidden: You do not have access to this channel"}|}
                            else
                              let* threads = Db.get_channel_threads ~channel_id in
                              Dream.json (threads_to_yojson threads |> Yojson.Safe.to_string)
      );

      (* File endpoints *)
      Dream.post "/api/upload/request-url" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some _user ->
                    let* body = Dream.body request in
                    match Yojson.Safe.from_string body |> upload_request_of_yojson with
                    | Error _ -> Dream.json ~status:`Bad_Request {|{"error": "Invalid JSON"}|}
                    | Ok { filename; content_type; size } ->
                        let storage_path = Printf.sprintf "uploads/%d-%s" (int_of_float (Unix.time ())) filename in
                        let credentials, region, bucket = get_s3_client () in
                        let* url_result = S3_client.presign_put ~credentials ~region ~bucket ~key:storage_path ~content_type () in
                        match url_result with
                        | Ok upload_url ->
                            Dream.json (upload_response_to_yojson {
                              upload_url;
                              storage_path;
                            } |> Yojson.Safe.to_string)
                        | Error _ ->
                            Dream.json ~status:`Internal_Server_Error {|{"error": "Failed to generate upload URL"}|}
      );

      Dream.get "/api/files/uploads/:filename" (fun request ->
        match Dream.header request "Authorization" with
        | None -> Dream.json ~status:`Unauthorized {|{"error": "No authorization header"}|}
        | Some token ->
            match verify_token token with
            | Error msg -> Dream.json ~status:`Unauthorized (Printf.sprintf {|{"error": "%s"}|} msg)
            | Ok user_id ->
                let* user_opt = Db.get_user_by_id ~id:user_id in
                match user_opt with
                | None -> Dream.json ~status:`Not_Found {|{"error": "User not found"}|}
                | Some user when user.role <> "admin" && user.role <> "member" ->
                    Dream.json ~status:`Forbidden {|{"error": "Insufficient permissions"}|}
                | Some _user ->
                    let filename = Dream.param request "filename" in
                    let* file_opt = Db.get_file_by_storage_path ~storage_path:filename in
                    match file_opt with
                    | None -> Dream.json ~status:`Not_Found {|{"error": "File not found"}|}
                    | Some file ->
                        let credentials, region, bucket = get_s3_client () in
                        let expiry = if file.is_image then 24 * 3600 else 300 in
                        let* url_result = S3_client.presign_get ~credentials ~region ~bucket ~key:file.storage_path () in
                        match url_result with
                        | Ok download_url ->
                            Dream.json (download_response_to_yojson {
                              download_url;
                              filename = file.filename;
                              is_image = file.is_image;
                              mime_type = file.mime_type;
                              size = file.size;
                            } |> Yojson.Safe.to_string)
                        | Error _ ->
                            Dream.json ~status:`Internal_Server_Error {|{"error": "Failed to generate download URL"}|}
      );

      (* WebSocket endpoint *)
      Dream.get "/ws" (fun req ->
        Dream.websocket (handle_ws_client req)
      );
    ] 