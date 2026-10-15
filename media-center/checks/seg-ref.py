#!/usr/bin/env python3
# Эталон ultralytics для checks/seg-check.cpp: тот же ONNX, из которого собран .rknn (голова one2many + NMS),
# conf 0.25, iou 0.45; сопоставление по классу и IoU рамки, IoU масок по растру исходного кадра.
#   python seg-ref.py --onnx out/yolo26n-seg-640-fp-rk3588/yolo26n-seg.onnx --image bus.jpg --ours ours.json
# Выход с кодом 1, если хоть одна эталонная детекция не нашлась или IoU маски ниже --min-mask-iou
# На CPU и без автоустановки: на GPU ultralytics ставит onnxruntime-gpu и поднимает protobuf, ломая rknn-toolkit2

import argparse
import json
import os
import sys

os.environ["YOLO_AUTOINSTALL"] = "False"

import cv2
import numpy as np
from ultralytics import YOLO


def box_iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def raster(polygons, h, w):
    mask = np.zeros((h, w), np.uint8)
    for flat in polygons:
        pts = np.array(flat, np.int32).reshape(-1, 2)
        if len(pts) >= 3:
            cv2.fillPoly(mask, [pts], 1)
    return mask


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--onnx", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--ours", required=True, help="JSON из seg-check")
    p.add_argument("--min-box-iou", type=float, default=0.5)
    p.add_argument("--min-mask-iou", type=float, default=0.7)
    args = p.parse_args()

    image = cv2.imread(args.image)
    h, w = image.shape[:2]
    r = YOLO(args.onnx, task="segment").predict(image, imgsz=640, conf=0.25, iou=0.45, retina_masks=True, device="cpu", verbose=False)[0]
    ref = [dict(cls=int(c), conf=float(s), box=b.tolist(), mask=m.astype(np.uint8))
           for c, s, b, m in zip(r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy(),
                                 r.boxes.xyxy.cpu().numpy(), r.masks.data.cpu().numpy() > 0.5)]

    ours = json.load(open(args.ours))
    print("ours: %s, %.1f ms, %d detections; reference: %d" % (ours["layout"], ours["ms"], len(ours["detections"]), len(ref)))

    failed = False
    used = set()
    for i, rd in enumerate(sorted(ref, key=lambda d: -d["conf"])):
        best, best_iou = None, 0.0
        for j, od in enumerate(ours["detections"]):
            if j in used or od["class"] != rd["cls"]:
                continue
            iou = box_iou(rd["box"], od["box"])
            if iou > best_iou:
                best, best_iou = j, iou
        if best is None or best_iou < args.min_box_iou:
            print("  ref %d class %d conf %.2f: NOT FOUND" % (i, rd["cls"], rd["conf"]))
            failed = True
            continue
        used.add(best)
        od = ours["detections"][best]
        mask = raster(od["polygons"], h, w)
        inter = np.logical_and(mask, rd["mask"]).sum()
        union = np.logical_or(mask, rd["mask"]).sum()
        mask_iou = inter / union if union else 0.0
        points = sum(len(pl) // 2 for pl in od["polygons"])
        bad = mask_iou < args.min_mask_iou
        failed |= bad
        print("  ref %d class %d conf %.2f/%.2f: box IoU %.3f, mask IoU %.3f, %d contours, %d points%s" % (
            i, rd["cls"], rd["conf"], od["conf"], best_iou, mask_iou, len(od["polygons"]), points, "  <-- LOW" if bad else ""))

    extra = len(ours["detections"]) - len(used)
    print("unmatched ours: %d" % extra)
    print("FAIL" if failed else "OK")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
