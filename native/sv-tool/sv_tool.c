/*
 * sv-tool: Annex-B H.264/H.265 on stdin, built on the Axis signed-video-framework.
 *
 *   sv-validate --codec h264|h265
 *       Validates signed video. Prints NDJSON to stdout:
 *         {"type":"gop","gop":N,"status":"valid|invalid|missing|unsigned|pending|version_mismatch",
 *          "expected":E,"received":R,"start_ts":us,"end_ts":us}
 *         {"type":"summary","signed":true|false,"authenticity":"...","valid":V,"invalid":I,"missing":M,
 *          "unsigned":U,"frames":F,"pubkey_validation":"ok|not_ok|not_feasible","version":"...",
 *          "signer_version":"...","serial":"...","firmware":"...","manufacturer":"...","hardware":"..."}
 *
 *   sv-sign --codec h264|h265 --key private.pem   (TEST ONLY — not shipped)
 *       Signs a stream and writes signed Annex-B to stdout.
 *
 * The program never reads files other than the optional key; input/output are pipes.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "signed_video_auth.h"
#include "signed_video_common.h"
#ifdef SV_TOOL_SIGN
#include "signed_video_sign.h"
#endif

typedef void (*nalu_cb)(const uint8_t *nalu, size_t size, void *ctx);

/* Stream Annex-B NAL units (each delivered WITH its start code) from a FILE. */
static int read_annexb(FILE *in, nalu_cb cb, void *ctx) {
  size_t cap = 8 << 20, len = 0;
  uint8_t *buf = malloc(cap);
  if (!buf) return -1;
  size_t start = SIZE_MAX; /* offset of current NAL's start code */
  size_t scan = 0;
  bool eof = false;
  while (!eof || scan + 3 <= len) {
    if (!eof && len + (1 << 20) > cap) {
      /* compact: drop bytes before the current NAL */
      size_t keep_from = start == SIZE_MAX ? (scan > 3 ? scan - 3 : 0) : start;
      memmove(buf, buf + keep_from, len - keep_from);
      len -= keep_from;
      scan -= keep_from;
      if (start != SIZE_MAX) start -= keep_from;
      if (len + (1 << 20) > cap) {
        cap *= 2;
        uint8_t *nb = realloc(buf, cap);
        if (!nb) {
          free(buf);
          return -1;
        }
        buf = nb;
      }
    }
    if (!eof && len - scan < 4) {
      size_t n = fread(buf + len, 1, cap - len, in);
      if (n == 0) eof = true;
      len += n;
      continue;
    }
    if (scan + 3 > len) break;
    /* look for 00 00 01 */
    if (buf[scan] == 0 && buf[scan + 1] == 0 && buf[scan + 2] == 1) {
      size_t sc = (scan > 0 && buf[scan - 1] == 0) ? scan - 1 : scan;
      if (start != SIZE_MAX && sc > start) cb(buf + start, sc - start, ctx);
      start = sc;
      scan += 3;
    } else {
      scan++;
    }
  }
  if (start != SIZE_MAX && len > start) cb(buf + start, len - start, ctx);
  free(buf);
  return 0;
}

static void json_str(const char *s) {
  putchar('"');
  for (; s && *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') {
      putchar('\\');
      putchar(c);
    } else if (c < 0x20) {
      printf("\\u%04x", c);
    } else {
      putchar(c);
    }
  }
  putchar('"');
}

static const char *auth_name(SignedVideoAuthenticityResult a) {
  switch (a) {
    case SV_AUTH_RESULT_NOT_SIGNED: return "unsigned";
    case SV_AUTH_RESULT_SIGNATURE_PRESENT: return "pending";
    case SV_AUTH_RESULT_NOT_OK: return "invalid";
    case SV_AUTH_RESULT_OK_WITH_MISSING_INFO: return "missing";
    case SV_AUTH_RESULT_OK: return "valid";
    case SV_AUTH_RESULT_VERSION_MISMATCH: return "version_mismatch";
    default: return "unknown";
  }
}

static const char *pk_name(SignedVideoPublicKeyValidation v) {
  switch (v) {
    case SV_PUBKEY_VALIDATION_OK: return "ok";
    case SV_PUBKEY_VALIDATION_NOT_OK: return "not_ok";
    default: return "not_feasible";
  }
}

typedef struct {
  signed_video_t *sv;
  int gop;
  int counts[8];
  int errors;
} vctx_t;

static void on_validate(const uint8_t *nalu, size_t size, void *p) {
  vctx_t *c = p;
  signed_video_authenticity_t *rep = NULL;
  SignedVideoReturnCode rc = signed_video_add_nalu_and_authenticate(c->sv, nalu, size, &rep);
  if (rc != SV_OK) c->errors++;
  if (rep) {
    signed_video_latest_validation_t *l = &rep->latest_validation;
    if (l->authenticity != SV_AUTH_RESULT_SIGNATURE_PRESENT) {
      if ((int)l->authenticity >= 0 && (int)l->authenticity < 8) c->counts[l->authenticity]++;
      printf("{\"type\":\"gop\",\"gop\":%d,\"status\":\"%s\",\"expected\":%d,\"received\":%d,\"start_ts\":%lld,\"end_ts\":%lld}\n",
          c->gop, auth_name(l->authenticity), l->number_of_expected_picture_nalus,
          l->number_of_received_picture_nalus, l->has_timestamp ? (long long)l->start_timestamp : 0LL,
          l->has_timestamp ? (long long)l->end_timestamp : 0LL);
      c->gop++;
    }
    signed_video_authenticity_report_free(rep);
  }
}

static int run_validate(SignedVideoCodec codec) {
  vctx_t c = {0};
  c.sv = signed_video_create(codec);
  if (!c.sv) {
    printf("{\"type\":\"summary\",\"error\":\"could not create validator\"}\n");
    return 2;
  }
  if (read_annexb(stdin, on_validate, &c) != 0) {
    printf("{\"type\":\"summary\",\"error\":\"out of memory\"}\n");
    return 2;
  }
  signed_video_authenticity_t *rep = signed_video_get_authenticity_report(c.sv);
  printf("{\"type\":\"summary\"");
  if (rep) {
    signed_video_accumulated_validation_t *a = &rep->accumulated_validation;
    printf(",\"signed\":%s,\"authenticity\":\"%s\"", a->authenticity != SV_AUTH_RESULT_NOT_SIGNED ? "true" : "false",
        auth_name(a->authenticity));
    printf(",\"frames\":%u,\"validated_frames\":%u,\"pubkey_validation\":\"%s\",\"public_key_changed\":%s",
        a->number_of_received_frames, a->number_of_validated_frames, pk_name(a->public_key_validation),
        a->public_key_has_changed ? "true" : "false");
    printf(",\"version\":");
    json_str(rep->this_version);
    printf(",\"signer_version\":");
    json_str(rep->version_on_signing_side);
    printf(",\"serial\":");
    json_str(rep->product_info.serial_number);
    printf(",\"firmware\":");
    json_str(rep->product_info.firmware_version);
    printf(",\"manufacturer\":");
    json_str(rep->product_info.manufacturer);
    printf(",\"hardware\":");
    json_str(rep->product_info.hardware_id);
    if (a->has_timestamp) printf(",\"first_ts\":%lld,\"last_ts\":%lld", (long long)a->first_timestamp, (long long)a->last_timestamp);
  } else {
    printf(",\"signed\":false");
  }
  printf(",\"valid\":%d,\"invalid\":%d,\"missing\":%d,\"unsigned\":%d,\"errors\":%d}\n", c.counts[SV_AUTH_RESULT_OK],
      c.counts[SV_AUTH_RESULT_NOT_OK], c.counts[SV_AUTH_RESULT_OK_WITH_MISSING_INFO], c.counts[SV_AUTH_RESULT_NOT_SIGNED], c.errors);
  if (rep) signed_video_authenticity_report_free(rep);
  signed_video_free(c.sv);
  fflush(stdout);
  return 0;
}

#ifdef SV_TOOL_SIGN
typedef struct {
  signed_video_t *sv;
  FILE *out;
  int64_t ts;
  int errors;
} sctx_t;

static void pull_seis(sctx_t *c, const uint8_t *peek, size_t peek_size) {
  uint8_t *sei = NULL;
  size_t sei_size = 0;
  while (signed_video_get_sei(c->sv, &sei, &sei_size, NULL, peek, peek_size, NULL) == SV_OK && sei_size > 0) {
    fwrite(sei, 1, sei_size, c->out);
    free(sei);
    sei = NULL;
    sei_size = 0;
  }
}

static void on_sign(const uint8_t *nalu, size_t size, void *p) {
  sctx_t *c = p;
  pull_seis(c, nalu, size);
  c->ts += 66666; /* ~15 fps, microseconds */
  SignedVideoReturnCode rc = signed_video_add_nalu_for_signing_with_timestamp(c->sv, nalu, size, &c->ts);
  if (rc != SV_OK) c->errors++;
  fwrite(nalu, 1, size, c->out);
}

static int run_sign(SignedVideoCodec codec, const char *key_path) {
  FILE *kf = fopen(key_path, "rb");
  if (!kf) {
    fprintf(stderr, "cannot open key\n");
    return 2;
  }
  char key[16384];
  size_t klen = fread(key, 1, sizeof(key), kf);
  fclose(kf);
  sctx_t c = {0};
  c.out = stdout;
  c.ts = 1760000000000000LL;
  c.sv = signed_video_create(codec);
  if (!c.sv || signed_video_set_private_key(c.sv, key, klen) != SV_OK) {
    fprintf(stderr, "cannot set key\n");
    return 2;
  }
  signed_video_add_public_key_to_sei(c.sv, true);
  signed_video_set_product_info(c.sv, "axhibit-test", "0.0", "TEST0001", "Axhibit test signer", "n/a");
  read_annexb(stdin, on_sign, &c);
  signed_video_set_end_of_stream(c.sv);
  pull_seis(&c, NULL, 0);
  signed_video_free(c.sv);
  fprintf(stderr, "signed with %d errors\n", c.errors);
  return c.errors ? 1 : 0;
}
#endif

int main(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  SignedVideoCodec codec = SV_CODEC_H264;
  const char *key = NULL;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--codec") && i + 1 < argc) {
      i++;
      codec = (!strcmp(argv[i], "h265") || !strcmp(argv[i], "hevc")) ? SV_CODEC_H265 : SV_CODEC_H264;
    } else if (!strcmp(argv[i], "--key") && i + 1 < argc) {
      key = argv[++i];
    } else if (!strcmp(argv[i], "--version")) {
      printf("%s\n", signed_video_get_version());
      return 0;
    }
  }
#ifdef SV_TOOL_SIGN
  if (!key) {
    fprintf(stderr, "usage: sv-sign --codec h264 --key private.pem < in.h264 > out.h264\n");
    return 2;
  }
  return run_sign(codec, key);
#else
  (void)key;
  return run_validate(codec);
#endif
}
